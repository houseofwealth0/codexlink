const os = require("os");
const { execFile } = require("child_process");
const { scanEnvironment } = require("../../shared/src/env-scan");

function parseArgs(argv) {
  return { once: argv.includes("--once") };
}

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
    return payload;
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
