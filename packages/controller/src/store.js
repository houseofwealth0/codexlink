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
      taskEvents: {},
      workspaceSessions: {},
      workerCommands: {},
      logs: []
    });
    this.data.apps ||= {};
    this.data.pairingCodes ||= {};
    this.data.setupPlans ||= {};
    this.data.setupStrategies ||= {};
    this.data.tasks ||= {};
    this.data.taskEvents ||= {};
    this.data.workspaceSessions ||= {};
    this.data.workerCommands ||= {};
    this.data.logs ||= [];
    for (const app of Object.values(this.data.apps)) {
      app.displayName ||= app.lastReport?.replit?.slug || app.lastReport?.package?.name || app.name;
      app.tags ||= [];
      app.notes ||= "";
      app.localPath ||= "";
      app.cloneStatus ||= app.git?.remote
        ? { status: app.localPath ? "ready" : "pending", remote: app.git.remote, path: app.localPath || null, message: app.localPath ? "Local checkout configured." : "Waiting to clone." }
        : app.git?.hasInternalReplitRemote
          ? { status: "external_remote_needed", remote: null, path: null, message: "Replit internal Git detected. Add an external Git remote for controller sync." }
        : { status: "skipped", remote: null, path: null, message: "No Git remote detected." };
      app.gitSync ||= {
        status: app.git?.hasExternalRemote ? "ready" : app.git?.hasInternalReplitRemote ? "internal_git_detected" : "not_available",
        message: app.git?.hasExternalRemote ? "External Git remote is configured." : app.git?.hasInternalReplitRemote ? "Replit internal Git detected." : "No Git repository detected.",
        remoteName: "codexlink",
        updatedAt: new Date().toISOString()
      };
    }
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
      displayName: report.replit?.slug || report.package?.name || report.appName,
      tags: [],
      notes: "",
      localPath: "",
      cloneStatus: report.git?.remote
        ? { status: "pending", remote: report.git.remote, path: null, message: "Local clone queued." }
        : report.git?.hasInternalReplitRemote
          ? { status: "external_remote_needed", remote: null, path: null, message: "Replit internal Git detected. Add an external Git remote for controller sync." }
        : { status: "skipped", remote: null, path: null, message: "No Git remote detected; automatic clone is unavailable." },
      gitSync: {
        status: report.git?.hasExternalRemote ? "ready" : report.git?.hasInternalReplitRemote ? "internal_git_detected" : "not_available",
        message: report.git?.hasExternalRemote ? "External Git remote is configured." : report.git?.hasInternalReplitRemote ? "Replit internal Git detected." : "No Git repository detected.",
        remoteName: "codexlink",
        updatedAt: new Date().toISOString()
      },
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

  updateWorkspace(appId, patch) {
    const app = this.getApp(appId);
    if (!app) return null;
    const allowed = {};
    if (Object.prototype.hasOwnProperty.call(patch, "displayName")) allowed.displayName = String(patch.displayName || app.name).trim() || app.name;
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) {
      allowed.tags = Array.isArray(patch.tags)
        ? patch.tags.map(String).map((tag) => tag.trim()).filter(Boolean)
        : String(patch.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "notes")) allowed.notes = String(patch.notes || "");
    if (Object.prototype.hasOwnProperty.call(patch, "localPath")) allowed.localPath = String(patch.localPath || "").trim();
    return this.updateApp(appId, allowed);
  }

  updateGitSync(appId, patch) {
    const app = this.getApp(appId);
    if (!app) return null;
    const gitSync = {
      ...(app.gitSync || {}),
      ...patch,
      updatedAt: new Date().toISOString()
    };
    return this.updateApp(appId, { gitSync });
  }

  getWorkspaceSession(appId) {
    this.data.workspaceSessions ||= {};
    if (!this.data.workspaceSessions[appId]) {
      this.data.workspaceSessions[appId] = {
        appId,
        status: "idle",
        transcript: [],
        activePid: null,
        startedAt: null,
        stoppedAt: null,
        updatedAt: new Date().toISOString()
      };
      this.save();
    }
    return this.data.workspaceSessions[appId];
  }

  updateWorkspaceSession(appId, patch) {
    const session = this.getWorkspaceSession(appId);
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return session;
  }

  addWorkspaceTranscript(appId, type, text, meta = {}) {
    const session = this.getWorkspaceSession(appId);
    const event = {
      id: crypto.randomUUID(),
      type,
      text: String(text ?? ""),
      meta,
      createdAt: new Date().toISOString()
    };
    session.transcript.push(event);
    session.transcript = session.transcript.slice(-1000);
    session.updatedAt = new Date().toISOString();
    this.save();
    return event;
  }

  clearWorkspaceTranscript(appId) {
    const session = this.getWorkspaceSession(appId);
    session.transcript = [];
    session.updatedAt = new Date().toISOString();
    this.save();
    return session;
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
      events: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.data.taskEvents[id] = [];
    this.addTaskEvent(id, "task", "Task queued.", { appId });
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

  addTaskEvent(taskId, type, message, meta = {}) {
    if (!this.data.taskEvents[taskId]) this.data.taskEvents[taskId] = [];
    const event = {
      id: crypto.randomUUID(),
      taskId,
      type,
      message,
      meta,
      createdAt: new Date().toISOString()
    };
    this.data.taskEvents[taskId].push(event);
    this.data.taskEvents[taskId] = this.data.taskEvents[taskId].slice(-500);
    const task = this.data.tasks[taskId];
    if (task) {
      task.events = this.data.taskEvents[taskId].slice(-50);
      task.updatedAt = new Date().toISOString();
    }
    this.save();
    return event;
  }

  listTaskEvents(taskId) {
    return this.data.taskEvents[taskId] || [];
  }

  enqueueWorkerCommand(appId, command) {
    this.data.workerCommands ||= {};
    if (!this.data.workerCommands[appId]) this.data.workerCommands[appId] = [];
    const queued = {
      id: crypto.randomUUID(),
      appId,
      status: "queued",
      createdAt: new Date().toISOString(),
      ...command
    };
    this.data.workerCommands[appId].push(queued);
    this.save();
    return queued;
  }

  takeWorkerCommands(appId) {
    this.data.workerCommands ||= {};
    const commands = this.data.workerCommands[appId] || [];
    const queued = commands.filter((command) => command.status === "queued");
    for (const command of queued) {
      command.status = "sent";
      command.sentAt = new Date().toISOString();
    }
    this.save();
    return queued;
  }

  completeWorkerCommand(appId, commandId, result) {
    this.data.workerCommands ||= {};
    const commands = this.data.workerCommands[appId] || [];
    const command = commands.find((candidate) => candidate.id === commandId);
    if (!command) return null;
    command.status = result?.ok === false ? "failed" : "completed";
    if (command.deployPrivateKey) command.deployPrivateKey = "[redacted]";
    command.result = result;
    command.completedAt = new Date().toISOString();
    this.save();
    return command;
  }

  listApps() {
    return Object.values(this.data.apps).sort((a, b) => a.name.localeCompare(b.name));
  }

  listTasks() {
    return Object.values(this.data.tasks).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}

module.exports = { Store };
