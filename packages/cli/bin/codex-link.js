#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const path = require("path");
const { scanEnvironment } = require("../../shared/src/env-scan");
const { applyActions } = require("../../shared/src/apply-actions");

const CLI_VERSION = "0.1.3";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function shellJsonValue(value) {
  return JSON.stringify(String(value || ""));
}

function readWorkerCredentials(root) {
  const config = readJsonFile(path.join(root, ".codex-link", "config.json")) || {};
  const daemonPath = path.join(root, ".codex-link", "worker-daemon.sh");
  const daemon = fs.existsSync(daemonPath) ? fs.readFileSync(daemonPath, "utf8") : "";
  const readExport = (name) => {
    const match = daemon.match(new RegExp(`^export ${name}=(.+)$`, "m"));
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return match[1].replace(/^["']|["']$/g, "");
    }
  };
  return {
    appId: config.appId || readExport("CODEX_LINK_APP_ID"),
    appToken: process.env.CODEX_LINK_APP_TOKEN || readExport("CODEX_LINK_APP_TOKEN"),
    controllerUrl: config.controllerUrl || readExport("CODEX_LINK_CONTROLLER")
  };
}

function updateLocalControllerConfig(root, controller, appId, appToken) {
  const dir = path.join(root, ".codex-link");
  const configPath = path.join(dir, "config.json");
  const config = readJsonFile(configPath) || {};
  writeJsonFile(configPath, {
    ...config,
    controllerUrl: controller,
    appId: appId || config.appId,
    workerMode: config.workerMode || "workspace",
    updatedAt: new Date().toISOString()
  });

  const daemonPath = path.join(dir, "worker-daemon.sh");
  if (fs.existsSync(daemonPath)) {
    let daemon = fs.readFileSync(daemonPath, "utf8");
    daemon = daemon.replace(/^export CODEX_LINK_CONTROLLER=.*$/m, `export CODEX_LINK_CONTROLLER=${shellJsonValue(controller)}`);
    if (appId) daemon = daemon.replace(/^export CODEX_LINK_APP_ID=.*$/m, `export CODEX_LINK_APP_ID=${shellJsonValue(appId)}`);
    if (appToken) daemon = daemon.replace(/^export CODEX_LINK_APP_TOKEN=.*$/m, `export CODEX_LINK_APP_TOKEN=${shellJsonValue(appToken)}`);
    fs.writeFileSync(daemonPath, daemon, "utf8");
  }

  const workerCommandPath = path.join(dir, "worker-command.sh");
  if (fs.existsSync(workerCommandPath)) {
    fs.writeFileSync(workerCommandPath, `CODEX_LINK_CONTROLLER=${controller} CODEX_LINK_APP_ID=${appId} CODEX_LINK_APP_TOKEN=$CODEX_LINK_APP_TOKEN npx --yes github:houseofwealth0/codexlink#main worker\n`, "utf8");
  }
}

async function postJson(url, body, headers = {}) {
  const target = new URL(url);
  const data = JSON.stringify(body);
  const client = target.protocol === "https:" ? https : http;
  const requestHeaders = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "user-agent": `codex-link-installer/${CLI_VERSION}`,
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

function printPlan(plan, actions) {
  console.log(`\nSetup plan for ${plan.appName}`);
  console.log(plan.summary);
  if (plan.reusedStrategy) console.log(`Reusing successful pattern ${plan.reusedStrategy.strategyId}.`);
  if (plan.warnings?.length) {
    console.log("\nWarnings:");
    for (const warning of plan.warnings) console.log(`- ${warning}`);
  }
  console.log("\nAuto actions:");
  for (const action of actions.auto) console.log(`- ${action.description} [${action.risk}]`);
  console.log("\nNeeds approval:");
  for (const action of actions.needsApproval) console.log(`- ${action.description} [${action.risk}]`);
}

async function install(args) {
  console.log(`Codex Link installer ${CLI_VERSION}`);
  const controller = args.controller || process.env.CODEX_LINK_CONTROLLER || await ask("Controller URL: ");
  const pairingCode = args["pairing-code"] || process.env.CODEX_LINK_PAIRING_CODE || await ask("Telegram pairing code: ");
  const mode = args.mode || "safe";
  const root = path.resolve(args.cwd || process.cwd());
  const report = scanEnvironment(root);

  console.log(`Scanned ${report.appName}: ${report.appType}, ${report.packageManager}`);
  const pair = await postJson(`${controller.replace(/\/$/, "")}/api/pair`, { pairingCode, report, mode });
  if (pair.app?.cloneStatus?.status) {
    console.log(`Controller local clone: ${pair.app.cloneStatus.status} - ${pair.app.cloneStatus.message || ""}`);
  }
  printPlan(pair.plan, pair.actions);

  let approved = args.yes || mode === "auto";
  if (!approved && pair.actions.needsApproval.length) {
    const answer = await ask("\nApply approved setup actions now? [y/N] ");
    approved = /^y(es)?$/i.test(answer);
  }

  const actionsToApply = approved ? [...pair.actions.auto, ...pair.actions.needsApproval] : pair.actions.auto;
  const results = applyActions(root, actionsToApply);
  await postJson(`${controller.replace(/\/$/, "")}/api/setup-result`, {
    planId: pair.plan.id,
    ok: true,
    results
  }, {
    "x-codex-link-app-id": pair.app.id,
    "x-codex-link-token": pair.app.token
  });

  console.log("\nApplied setup actions:");
  for (const result of results) {
    console.log(`- ${result.path}${result.backup ? ` (backup: ${result.backup})` : ""}`);
  }
  console.log("\nApp connected. Starting persistent worker daemon...");

  const env = {
    ...process.env,
    CODEX_LINK_CONTROLLER: controller,
    CODEX_LINK_APP_ID: pair.app.id,
    CODEX_LINK_APP_TOKEN: pair.app.token,
    CODEX_LINK_WORKER_MODE: "workspace"
  };

  const daemonPath = path.join(root, ".codex-link", "worker-daemon.sh");
  if (fs.existsSync(daemonPath)) {
    const child = spawn("sh", [daemonPath], {
      cwd: root,
      env,
      stdio: "ignore",
      detached: true
    });
    child.unref();
    console.log(`Worker daemon started with pid ${child.pid}.`);
  } else {
    console.log("Worker daemon script was not found; starting one-time verification only.");
  }

  console.log("Verifying worker heartbeat...");
  const verify = spawn(process.execPath, [path.join(__dirname, "../../worker/src/worker.js"), "--once"], {
    cwd: root,
    env,
    stdio: "inherit"
  });
  const code = await new Promise((resolve) => verify.on("exit", resolve));
  if (code === 0) {
    console.log("App should remain online while the Replit workspace keeps the worker daemon running.");
  } else {
    throw new Error(`Worker verification failed with exit code ${code}`);
  }
}

async function reconnect(args) {
  console.log(`Codex Link reconnect ${CLI_VERSION}`);
  const controller = args.controller || process.env.CODEX_LINK_CONTROLLER || await ask("New controller URL: ");
  const root = path.resolve(args.cwd || process.cwd());
  const credentials = readWorkerCredentials(root);
  const appId = args["app-id"] || credentials.appId;
  const appToken = args["app-token"] || credentials.appToken;
  if (!appId || !appToken) {
    throw new Error("Could not find existing app id/token. Run this from the paired Replit workspace.");
  }

  updateLocalControllerConfig(root, controller, appId, appToken);
  const report = scanEnvironment(root);
  await postJson(`${controller.replace(/\/$/, "")}/api/reconnect`, { report, controllerUrl: controller }, {
    "x-codex-link-app-id": appId,
    "x-codex-link-token": appToken
  });
  console.log("Updated local worker controller URL.");

  const daemonPath = path.join(root, ".codex-link", "worker-daemon.sh");
  if (fs.existsSync(daemonPath)) {
    const child = spawn("sh", [daemonPath], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_LINK_CONTROLLER: controller,
        CODEX_LINK_APP_ID: appId,
        CODEX_LINK_APP_TOKEN: appToken,
        CODEX_LINK_WORKER_MODE: "workspace"
      },
      stdio: "ignore",
      detached: true
    });
    child.unref();
    console.log(`Worker daemon restarted with pid ${child.pid}.`);
  }

  const verify = spawn(process.execPath, [path.join(__dirname, "../../worker/src/worker.js"), "--once"], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_LINK_CONTROLLER: controller,
      CODEX_LINK_APP_ID: appId,
      CODEX_LINK_APP_TOKEN: appToken,
      CODEX_LINK_WORKER_MODE: "workspace"
    },
    stdio: "inherit"
  });
  const code = await new Promise((resolve) => verify.on("exit", resolve));
  if (code !== 0) throw new Error(`Worker verification failed with exit code ${code}`);
  console.log("Reconnect complete. App should show online shortly.");
}

async function scan(args) {
  console.log(JSON.stringify(scanEnvironment(path.resolve(args.cwd || process.cwd())), null, 2));
}

async function worker() {
  require("../../worker/src/worker").main(process.argv.slice(3));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  if (command === "install") return install(args);
  if (command === "reconnect") return reconnect(args);
  if (command === "scan") return scan(args);
  if (command === "worker") return worker(args);
  console.log("Usage: codex-link install|reconnect|scan|worker");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
