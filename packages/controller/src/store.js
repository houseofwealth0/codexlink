const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "store.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = readJson(this.filePath, {
      apps: {},
      pairingCodes: {},
      setupPlans: {},
      setupStrategies: {},
      tasks: {},
      logs: []
    });
  }

  save() {
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }

  log(type, message, meta = {}) {
    this.data.logs.unshift({ id: crypto.randomUUID(), type, message, meta, createdAt: new Date().toISOString() });
    this.data.logs = this.data.logs.slice(0, 300);
    this.save();
  }

  createPairingCode(chatId = null) {
    const code = crypto.randomBytes(3).toString("hex").toUpperCase();
    this.data.pairingCodes[code] = {
      code,
      chatId,
      used: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
    };
    this.save();
    return this.data.pairingCodes[code];
  }

  consumePairingCode(code) {
    const record = this.data.pairingCodes[String(code || "").toUpperCase()];
    if (!record || record.used || Date.parse(record.expiresAt) < Date.now()) return null;
    record.used = true;
    record.usedAt = new Date().toISOString();
    this.save();
    return record;
  }

  registerApp({ report, controllerUrl, pairingCode }) {
    const appId = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("base64url");
    const app = {
      id: appId,
      token,
      name: report.appName,
      appType: report.appType,
      packageManager: report.packageManager,
      controllerUrl,
      pairingCode,
      workerMode: "workspace",
      status: "pairing",
      git: report.git,
      lastReport: report,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastHeartbeatAt: null
    };
    this.data.apps[appId] = app;
    this.save();
    return app;
  }

  getApp(appId) {
    return this.data.apps[appId] || null;
  }

  authenticateApp(appId, token) {
    const app = this.getApp(appId);
    if (!app || app.token !== token) return null;
    return app;
  }

  updateApp(appId, patch) {
    const app = this.getApp(appId);
    if (!app) return null;
    Object.assign(app, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return app;
  }

  recordSetupPlan(appId, plan, mode) {
    this.data.setupPlans[plan.id] = {
      ...plan,
      appId,
      mode,
      status: "planned",
      appliedResults: [],
      approvedAt: null
    };
    this.save();
    return this.data.setupPlans[plan.id];
  }

  getSetupPlan(planId) {
    return this.data.setupPlans[planId] || null;
  }

  updateSetupPlan(planId, patch) {
    const plan = this.getSetupPlan(planId);
    if (!plan) return null;
    Object.assign(plan, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return plan;
  }

  getRememberedStrategy(patternKey) {
    return this.data.setupStrategies[patternKey] || null;
  }

  rememberSuccessfulSetup(plan) {
    this.data.setupStrategies[plan.patternKey] = {
      strategyId: plan.id,
      appType: plan.appType,
      patternKey: plan.patternKey,
      actions: plan.actions.map((action) => ({ id: action.id, type: action.type, path: action.path, risk: action.risk })),
      successfulInstalls: (this.data.setupStrategies[plan.patternKey]?.successfulInstalls || 0) + 1,
      updatedAt: new Date().toISOString()
    };
    this.save();
  }

  createTask({ appId, prompt }) {
    const id = crypto.randomUUID();
    this.data.tasks[id] = {
      id,
      appId,
      prompt,
      status: "queued",
      branch: `codex/task-${id.slice(0, 8)}`,
      summary: null,
      diff: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.data.tasks[id];
  }

  updateTask(taskId, patch) {
    const task = this.data.tasks[taskId];
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return task;
  }

  listApps() {
    return Object.values(this.data.apps).sort((a, b) => a.name.localeCompare(b.name));
  }

  listTasks() {
    return Object.values(this.data.tasks).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}

module.exports = { Store };
