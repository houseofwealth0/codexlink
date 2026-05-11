const crypto = require("crypto");

function stablePattern(report) {
  const parts = [
    report.appType,
    report.packageManager,
    report.files?.hasReplit ? "replit" : "no-replit",
    report.files?.hasPackageJson ? "package-json" : "no-package-json",
    report.files?.hasRequirements ? "requirements" : "no-requirements"
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function workerCommand(controllerUrl, appId, appToken) {
  return `CODEX_LINK_CONTROLLER=${controllerUrl} CODEX_LINK_APP_ID=${appId} CODEX_LINK_APP_TOKEN=${appToken} npx codex-link worker`;
}

function packageJsonAction(report) {
  if (!report.files?.hasPackageJson) return null;
  const patch = {
    "scripts.codex-link": "codex-link worker",
    "scripts.codex-link:install-check": "codex-link scan"
  };
  const actions = [{
    id: "patch-package-json",
    risk: "startup",
    type: "patch_json",
    path: "package.json",
    patch,
    description: "Add scripts for starting and checking the Codex Link worker."
  }];

  const scripts = report.package?.scripts || {};
  if (scripts.start && !scripts["codex-link:app"]) {
    actions.push({
      id: "write-node-start-wrapper",
      risk: "startup",
      type: "write_file",
      path: ".codex-link/start-with-worker.cjs",
      content: [
        "const { spawn } = require('child_process');",
        "",
        "const shell = process.platform === 'win32' ? 'cmd' : 'sh';",
        "const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c'] : ['-lc'];",
        "const worker = spawn(shell, [...shellArgs, 'npx codex-link worker'], {",
        "  cwd: process.cwd(), env: process.env, stdio: 'ignore', detached: true",
        "});",
        "worker.unref();",
        "",
        "const app = spawn(shell, [...shellArgs, 'npm run codex-link:app'], {",
        "  cwd: process.cwd(), env: process.env, stdio: 'inherit'",
        "});",
        "app.on('exit', (code, signal) => {",
        "  if (signal) process.kill(process.pid, signal);",
        "  process.exit(code || 0);",
        "});",
        ""
      ].join("\n"),
      description: "Write a Node startup wrapper that launches the worker beside the app."
    });
    actions.push({
      id: "patch-node-start-script",
      risk: "startup",
      type: "patch_json",
      path: "package.json",
      patch: {
        "scripts.codex-link:app": scripts.start,
        "scripts.start": "node .codex-link/start-with-worker.cjs"
      },
      description: "Wrap npm start so the Codex Link worker reconnects whenever the app starts."
    });
  }

  return actions;
}

function replitAction(report) {
  if (!report.files?.hasReplit) {
    return {
      id: "create-replit-helper",
      risk: "startup",
      type: "write_file",
      path: ".codex-link/replit-run-note.txt",
      content: "Codex Link is paired. Add `codex-link worker` to your Replit startup command if automatic reconnect does not start.\n",
      description: "Write a fallback note because no .replit file was detected."
    };
  }
  return {
    id: "write-replit-autostart-note",
    risk: "startup",
    type: "write_file",
    path: ".codex-link/autostart.md",
    content: [
      "# Codex Link Autostart",
      "",
      "This app has a .replit file. The installer keeps the app run command intact and adds helper scripts/config.",
      "If the worker does not reconnect after workspace restart, run `npx codex-link worker` or wire that command into the app's startup flow.",
      ""
    ].join("\n"),
    description: "Record app-specific autostart guidance without changing the main run command."
  };
}

function createSetupPlan({ report, controllerUrl, appId, appToken, rememberedStrategy }) {
  const patternKey = stablePattern(report);
  const actions = [
    {
      id: "write-config",
      risk: "safe",
      type: "write_json",
      path: ".codex-link/config.json",
      content: {
        controllerUrl,
        appId,
        appName: report.appName,
        workerMode: "workspace",
        createdAt: new Date().toISOString()
      },
      description: "Store non-secret Codex Link app configuration."
    },
    {
      id: "write-env-example",
      risk: "safe",
      type: "write_file",
      path: ".codex-link/env.example",
      content: [
        `CODEX_LINK_CONTROLLER=${controllerUrl}`,
        `CODEX_LINK_APP_ID=${appId}`,
        "CODEX_LINK_APP_TOKEN=<stored in Replit secrets>",
        ""
      ].join("\n"),
      description: "Write an env example showing the variables needed by the worker."
    },
    {
      id: "write-worker-command",
      risk: "safe",
      type: "write_file",
      path: ".codex-link/worker-command.sh",
      content: `${workerCommand(controllerUrl, appId, "$CODEX_LINK_APP_TOKEN")}\n`,
      executable: true,
      description: "Write a helper command that starts the worker."
    }
  ];

  const pkgActions = packageJsonAction(report);
  if (pkgActions) actions.push(...pkgActions);
  actions.push(replitAction(report));

  return {
    id: crypto.randomUUID(),
    appName: report.appName,
    appType: report.appType,
    patternKey,
    reusedStrategy: rememberedStrategy ? {
      strategyId: rememberedStrategy.strategyId,
      successfulInstalls: rememberedStrategy.successfulInstalls
    } : null,
    recommendedMode: "safe",
    summary: `Detected ${report.appType} app using ${report.packageManager}. Configure Codex Link workspace worker with guarded startup integration.`,
    actions,
    warnings: [
      report.git?.present ? null : "No Git repository detected. Branch + approve coding tasks will need a durable Git remote before they are fully safe.",
      report.git?.dirty ? "Git working tree appears dirty. Review before running coding tasks." : null
    ].filter(Boolean),
    createdAt: new Date().toISOString()
  };
}

function actionsForMode(plan, mode) {
  if (mode === "ask") return { auto: [], needsApproval: plan.actions };
  if (mode === "auto") return { auto: plan.actions, needsApproval: [] };
  const auto = plan.actions.filter((action) => action.risk === "safe");
  const needsApproval = plan.actions.filter((action) => action.risk !== "safe");
  return { auto, needsApproval };
}

module.exports = { createSetupPlan, actionsForMode, stablePattern };
