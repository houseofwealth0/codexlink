const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { scanEnvironment } = require("../../shared/src/env-scan");

const WORKER_VERSION = "0.1.3";

function parseArgs(argv) {
  return { once: argv.includes("--once") };
}

function postJson(url, body, headers = {}) {
  const target = new URL(url);
  const data = JSON.stringify(body);
  const client = target.protocol === "https:" ? https : http;
  const requestHeaders = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "user-agent": `codex-link-worker/${WORKER_VERSION}`,
    ...headers
  };

  return new Promise((resolve, reject) => {
    const request = client.request(target, { method: "POST", headers: requestHeaders }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        let payload = {};
        try {
          payload = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          payload = { raw: responseBody.slice(0, 500) };
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = payload.error || payload.message || payload.raw || JSON.stringify(payload).slice(0, 300) || response.statusMessage;
          reject(new Error(`Request failed: ${response.statusCode} ${message}`));
          return;
        }
        resolve(payload);
      });
    });
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

function runCommand(command, args, cwd, options = {}) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" && /\.cmd$/i.test(command);
    execFile(command, args, { cwd, maxBuffer: 1024 * 1024, shell, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code || 0, stdout, stderr });
    });
  });
}

function redactResult(result) {
  const redact = (value) => String(value || "").replace(/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g, "[redacted private key]");
  return {
    ...result,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    error: result.error ? redact(result.error) : result.error
  };
}

async function ensureIgnored(root) {
  const ignorePath = path.join(root, ".gitignore");
  const entry = ".codex-link/";
  const current = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  if (!current.split(/\r?\n/).includes(entry)) {
    fs.appendFileSync(ignorePath, `${current.endsWith("\n") || !current ? "" : "\n"}${entry}\n`, "utf8");
  }
}

async function git(root, args, env) {
  return runCommand(process.env.CODEX_LINK_GIT_BIN || "git", args, root, { env: { ...process.env, ...env } });
}

async function configureGithubRemote(command, root) {
  const dir = path.join(root, ".codex-link");
  fs.mkdirSync(dir, { recursive: true });
  await ensureIgnored(root);

  const keyPath = path.join(dir, "github_deploy_key");
  fs.writeFileSync(keyPath, command.deployPrivateKey || "", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // chmod is best-effort on some filesystems.
  }

  const gitEnv = {
    GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
  };
  const remoteName = command.remoteName || "codexlink";
  const branch = command.targetBranch || "main";
  const steps = [];

  let result = await git(root, ["remote", "get-url", remoteName], gitEnv);
  if (result.ok) {
    result = await git(root, ["remote", "set-url", remoteName, command.sshUrl], gitEnv);
    steps.push({ step: "remote-set-url", ok: result.ok, stderr: result.stderr });
  } else {
    result = await git(root, ["remote", "add", remoteName, command.sshUrl], gitEnv);
    steps.push({ step: "remote-add", ok: result.ok, stderr: result.stderr });
  }
  if (!result.ok) return redactResult({ ok: false, step: "remote", stderr: result.stderr, stdout: result.stdout });

  await git(root, ["config", "user.name", "Codex Link"], gitEnv);
  await git(root, ["config", "user.email", "codex-link@local"], gitEnv);

  const status = await git(root, ["status", "--porcelain"], gitEnv);
  if (status.stdout.trim()) {
    result = await git(root, ["add", "-A"], gitEnv);
    steps.push({ step: "add", ok: result.ok, stderr: result.stderr });
    if (!result.ok) return redactResult({ ok: false, step: "add", stderr: result.stderr, stdout: result.stdout });

    result = await git(root, ["commit", "-m", command.bootstrapMessage || "Codex Link bootstrap snapshot"], gitEnv);
    steps.push({ step: "commit", ok: result.ok, stderr: result.stderr });
    if (!result.ok) return redactResult({ ok: false, step: "commit", stderr: result.stderr, stdout: result.stdout });
  }

  result = await git(root, ["push", "-u", remoteName, `HEAD:${branch}`], gitEnv);
  steps.push({ step: "push", ok: result.ok, stderr: result.stderr });
  if (!result.ok) return redactResult({ ok: false, step: "push", stderr: result.stderr, stdout: result.stdout });

  return redactResult({ ok: true, remoteName, branch, steps, stdout: result.stdout, stderr: result.stderr });
}

async function handleCommand(command, root) {
  if (command.type === "run_command") {
    return runCommand(command.command, command.args || [], root);
  }
  if (command.type === "configure_github_remote") {
    return configureGithubRemote(command, root);
  }
  return { ok: false, error: `Unknown command type ${command.type}` };
}

async function heartbeat() {
  const controller = process.env.CODEX_LINK_CONTROLLER;
  const appId = process.env.CODEX_LINK_APP_ID;
  const token = process.env.CODEX_LINK_APP_TOKEN;
  if (!controller || !appId || !token) {
    throw new Error("CODEX_LINK_CONTROLLER, CODEX_LINK_APP_ID, and CODEX_LINK_APP_TOKEN are required.");
  }
  const root = process.cwd();
  const payload = {
    workerMode: process.env.CODEX_LINK_WORKER_MODE || "workspace",
    workerVersion: WORKER_VERSION,
    hostname: os.hostname(),
    platform: process.platform,
    pid: process.pid,
    report: scanEnvironment(root)
  };
  const response = await postJson(`${controller.replace(/\/$/, "")}/api/heartbeat`, payload, {
    "x-codex-link-app-id": appId,
    "x-codex-link-token": token
  });
  const results = [];
  for (const command of response.commands || []) {
    const result = await handleCommand(command, root);
    results.push({ commandId: command.id, result });
  }
  if (results.length) {
    await postJson(`${controller.replace(/\/$/, "")}/api/command-results`, { results }, {
      "x-codex-link-app-id": appId,
      "x-codex-link-token": token
    });
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.once) {
    await heartbeat();
    console.log("Codex Link worker heartbeat ok.");
    return;
  }
  console.log("Codex Link worker started.");
  for (;;) {
    try {
      await heartbeat();
    } catch (error) {
      console.error(`Codex Link worker heartbeat failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main, heartbeat, handleCommand, configureGithubRemote };
