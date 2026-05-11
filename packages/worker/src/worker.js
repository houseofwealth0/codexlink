const os = require("os");
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

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code || 0, stdout, stderr });
    });
  });
}

async function handleCommand(command, root) {
  if (command.type === "run_command") {
    return runCommand(command.command, command.args || [], root);
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
  for (const command of response.commands || []) {
    await handleCommand(command, root);
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

module.exports = { main, heartbeat, handleCommand };
