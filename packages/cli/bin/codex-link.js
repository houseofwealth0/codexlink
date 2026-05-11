#!/usr/bin/env node
const readline = require("readline");
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

async function postJson(url, body, headers = {}) {
  const target = new URL(url);
  const data = JSON.stringify(body);
  const client = target.protocol === "https:" ? https : http;
  const requestHeaders = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "ngrok-skip-browser-warning": "1",
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
  console.log("\nApp connected. Starting worker once for verification...");

  const env = {
    ...process.env,
    CODEX_LINK_CONTROLLER: controller,
    CODEX_LINK_APP_ID: pair.app.id,
    CODEX_LINK_APP_TOKEN: pair.app.token,
    CODEX_LINK_WORKER_MODE: "workspace"
  };
  const child = spawn(process.execPath, [path.join(__dirname, "../../worker/src/worker.js"), "--once"], {
    cwd: root,
    env,
    stdio: "inherit"
  });
  await new Promise((resolve) => child.on("exit", resolve));
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
  if (command === "scan") return scan(args);
  if (command === "worker") return worker(args);
  console.log("Usage: codex-link install|scan|worker");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
