const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { Store } = require("./store");
const { startTelegramBot } = require("./telegram");
const { createSetupPlan, actionsForMode } = require("../../shared/src/setup-agent");

const PORT = Number(process.env.CODEX_LINK_PORT || 8787);
const HOST = process.env.CODEX_LINK_HOST || "0.0.0.0";
const BASE_URL = process.env.CODEX_LINK_BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = path.resolve(process.env.CODEX_LINK_DATA_DIR || "codex-link-data");

const store = new Store(DATA_DIR);

function externalBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  if (forwardedProto && forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  const host = req.headers.host;
  if (host && !host.startsWith("localhost") && !host.startsWith("127.0.0.1")) {
    return `https://${host}`;
  }
  return BASE_URL;
}

function isLocalRequest(req) {
  const remote = req.socket.remoteAddress;
  const host = req.headers.host || "";
  return remote === "127.0.0.1"
    || remote === "::1"
    || remote === "::ffff:127.0.0.1"
    || host.startsWith("localhost:")
    || host.startsWith("127.0.0.1:");
}

function getJson(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 200_000) request.destroy();
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
  });
}

function detectCloudflaredUrl() {
  const fs = require("fs");
  const tunnelFile = path.join(DATA_DIR, "tunnel-url.txt");
  if (!fs.existsSync(tunnelFile)) return null;
  const value = fs.readFileSync(tunnelFile, "utf8").trim();
  return /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(value) ? value : null;
}

async function detectPublicTunnelUrl() {
  if (process.env.CODEX_LINK_PUBLIC_URL) return process.env.CODEX_LINK_PUBLIC_URL;
  return detectCloudflaredUrl();
}

async function installBaseUrl(req) {
  const requestBase = externalBaseUrl(req);
  if (requestBase !== BASE_URL) return requestBase;
  return await detectPublicTunnelUrl() || BASE_URL;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function authenticate(req) {
  const appId = req.headers["x-codex-link-app-id"];
  const token = req.headers["x-codex-link-token"];
  return store.authenticateApp(appId, token);
}

function stopTunnelProcesses() {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/IM", "cloudflared.exe", "/F"], (error) => {
      resolve({ ok: !error, error: error?.message || null });
    });
  });
}

async function htmlPage(req) {
  const apps = store.listApps();
  const tasks = store.listTasks();
  const logs = store.data.logs.slice(0, 30);
  const plans = Object.values(store.data.setupPlans).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const onlineCutoff = Date.now() - 90_000;
  const publicTunnelUrl = await detectPublicTunnelUrl();
  const publicInstallUrl = await installBaseUrl(req);
  const installCommand = publicTunnelUrl
    ? `npx --yes github:houseofwealth0/codexlink#main install --controller ${publicTunnelUrl} --pairing-code YOUR_CODE`
    : "Public tunnel not detected. Start Codex Link Launcher, then refresh this dashboard to get the Replit install command.";
  const tunnelStatus = publicTunnelUrl
    ? `<p><span class="pill online">public tunnel online</span> <code>${escapeHtml(publicTunnelUrl)}</code></p>`
    : `<p><span class="pill offline">public tunnel not detected</span> Start Codex Link Launcher or the tunnel window, then refresh.</p>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Link</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fb; color: #1b1f2a; }
    header { padding: 24px; border-bottom: 1px solid #dfe3ea; background: #ffffff; }
    .header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 24px; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
    section { background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    form { display: inline; }
    .block-form { display: grid; gap: 10px; max-width: 760px; }
    select, textarea, input { font: inherit; border: 1px solid #cfd6e3; border-radius: 6px; padding: 9px; background: #fff; color: inherit; }
    textarea { min-height: 92px; resize: vertical; }
    button { border: 0; border-radius: 6px; background: #1f6feb; color: white; padding: 9px 12px; cursor: pointer; font-weight: 600; }
    .danger { background: #b42318; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #edf0f5; text-align: left; vertical-align: top; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f2f4f8; padding: 12px; border-radius: 6px; }
    .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: #eef2ff; color: #243b7a; }
    .online { background: #e8f7ee; color: #14532d; }
    .offline { background: #f3f4f6; color: #4b5563; }
    @media (prefers-color-scheme: dark) {
      body { background: #101319; color: #eef2f7; }
      header, section { background: #171b23; border-color: #2a303b; }
      th, td { border-color: #272d37; }
      pre { background: #11151c; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <h1>Codex Link</h1>
        <p>Controller: <code>${BASE_URL}</code></p>
      </div>
      <form method="post" action="/shutdown" onsubmit="return confirm('Shut down Codex Link controller and Cloudflare Tunnel?');">
        <button class="danger" type="submit">Shut Down Codex Link</button>
      </form>
    </div>
  </header>
  <main>
    <section>
      <h2>Pair A Replit App</h2>
      ${tunnelStatus}
      <form method="post" action="/pairing-code">
        <button type="submit">Create Pairing Code</button>
      </form>
      <p>Then run this in Replit with your public tunnel URL:</p>
      <pre>${escapeHtml(installCommand)}</pre>
    </section>
    <section>
      <h2>Connected Apps</h2>
      <table>
        <thead><tr><th>Status</th><th>Name</th><th>Type</th><th>Git</th><th>Last Heartbeat</th></tr></thead>
        <tbody>
          ${apps.map((app) => {
            const online = app.lastHeartbeatAt && Date.parse(app.lastHeartbeatAt) > onlineCutoff;
            return `<tr><td><span class="pill ${online ? "online" : "offline"}">${online ? "online" : "offline"}</span></td><td>${app.name}<br><code>${app.id}</code></td><td>${app.appType}<br>${app.packageManager}</td><td>${app.git?.present ? "present" : "missing"}<br><code>${app.git?.branch || ""}</code></td><td>${app.lastHeartbeatAt || "never"}</td></tr>`;
          }).join("") || `<tr><td colspan="5">No apps yet. Use <code>/connect</code> in Telegram, then run <code>npx codex-link install</code>.</td></tr>`}
        </tbody>
      </table>
    </section>
    <section>
      <h2>Start Codex Task</h2>
      ${apps.length ? `<form class="block-form" method="post" action="/tasks">
        <label>App
          <select name="appId">
            ${apps.map((app) => `<option value="${escapeHtml(app.id)}">${escapeHtml(app.name)} (${escapeHtml(app.appType)})</option>`).join("")}
          </select>
        </label>
        <label>Instruction
          <textarea name="prompt" placeholder="Tell Codex what to inspect or change..."></textarea>
        </label>
        <button type="submit">Start Live Task</button>
      </form>` : "Connect an app before starting a task."}
    </section>
    <section>
      <h2>Setup Plans</h2>
      ${plans.slice(0, 8).map((plan) => `<p><span class="pill">${plan.status}</span> <strong>${plan.appName}</strong> ${plan.appType} ${plan.reusedStrategy ? "(reused strategy)" : "(new strategy)"}<br><code>${plan.id}</code></p><pre>${plan.summary}\n\n${plan.actions.map((a) => `${a.risk}: ${a.description} (${a.path})`).join("\n")}</pre>`).join("") || "No setup plans yet."}
    </section>
    <section>
      <h2>Tasks</h2>
      ${tasks.slice(0, 10).map((task) => `<p><span class="pill">${task.status}</span> <a href="/tasks/${task.id}"><code>${task.id}</code></a> ${escapeHtml(task.prompt)}</p><pre>${escapeHtml(task.summary || "")}\n${escapeHtml(task.diff || "")}</pre>`).join("") || "No tasks yet."}
    </section>
    <section>
      <h2>Logs</h2>
      <pre>${logs.map((log) => `${log.createdAt} ${log.type}: ${log.message}`).join("\n")}</pre>
    </section>
  </main>
</body>
</html>`;
}

function taskPage(taskId) {
  const task = store.data.tasks[taskId];
  if (!task) {
    return `<!doctype html><html><body><h1>Task not found</h1><p><a href="/">Back</a></p></body></html>`;
  }
  const app = store.getApp(task.appId);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Link Task</title>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fb; color: #1b1f2a; }
    header { padding: 24px; background: #fff; border-bottom: 1px solid #dfe3ea; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
    section { background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; padding: 18px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #101319; color: #eef2f7; padding: 14px; border-radius: 8px; min-height: 320px; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: #eef2ff; color: #243b7a; }
    button { border: 0; border-radius: 6px; background: #1f6feb; color: white; padding: 9px 12px; cursor: pointer; font-weight: 600; }
    .danger { background: #b42318; }
  </style>
</head>
<body>
  <header>
    <p><a href="/">Back to dashboard</a></p>
    <h1>Live Task</h1>
    <p><span id="status" class="pill">${escapeHtml(task.status)}</span> <code>${escapeHtml(task.id)}</code></p>
    <p><strong>${escapeHtml(app?.name || "Unknown app")}</strong>: ${escapeHtml(task.prompt)}</p>
  </header>
  <main>
    <section>
      <h2>Live Run</h2>
      <pre id="events"></pre>
    </section>
    <section>
      <h2>Controls</h2>
      <form method="post" action="/tasks/${escapeHtml(task.id)}/queue-command">
        <input type="hidden" name="command" value="git" />
        <input type="hidden" name="args" value="status --short" />
        <button type="submit">Queue git status</button>
      </form>
      <form method="post" action="/tasks/${escapeHtml(task.id)}/stop" style="display:inline">
        <button class="danger" type="submit">Stop Task</button>
      </form>
    </section>
  </main>
  <script>
    const out = document.getElementById('events');
    const status = document.getElementById('status');
    function line(event) {
      const when = new Date(event.createdAt).toLocaleTimeString();
      return '[' + when + '] ' + event.type + ': ' + event.message + '\\n';
    }
    const source = new EventSource('/tasks/${escapeHtml(task.id)}/events');
    source.onmessage = (message) => {
      const payload = JSON.parse(message.data);
      if (payload.task?.status) status.textContent = payload.task.status;
      for (const event of payload.events || []) out.textContent += line(event);
      out.scrollTop = out.scrollHeight;
    };
  </script>
</body>
</html>`;
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
  });
}

function taskSse(req, res, taskId) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  let lastIndex = 0;
  const send = () => {
    const events = store.listTaskEvents(taskId);
    const nextEvents = events.slice(lastIndex);
    lastIndex = events.length;
    const task = store.data.tasks[taskId] || null;
    res.write(`data: ${JSON.stringify({ task, events: nextEvents })}\n\n`);
  };
  send();
  const interval = setInterval(send, 1500);
  req.on("close", () => clearInterval(interval));
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/apps") return sendJson(res, 200, { apps: store.listApps() });
  if (req.method === "GET" && url.pathname === "/api/tasks") return sendJson(res, 200, { tasks: store.listTasks() });
  if (req.method === "GET" && url.pathname === "/api/tunnel") return sendJson(res, 200, { publicUrl: await detectPublicTunnelUrl() });

  if (req.method === "POST" && url.pathname === "/pairing-code") {
    const code = store.createPairingCode("dashboard");
    res.writeHead(303, { location: `/pairing-code?code=${encodeURIComponent(code.code)}` });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/pairing-code") {
    const code = url.searchParams.get("code");
    const controllerUrl = await installBaseUrl(req);
    const command = controllerUrl === BASE_URL
      ? "Start the public tunnel from the Codex Link Launcher, then refresh and create a new pairing code."
      : `npx --yes github:houseofwealth0/codexlink#main install --controller ${controllerUrl} --pairing-code ${code}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pairing Code</title><style>body{font-family:system-ui;margin:32px;line-height:1.5}code,pre{font-family:ui-monospace,Consolas,monospace}pre{background:#f2f4f8;padding:16px;border-radius:8px;white-space:pre-wrap}</style></head><body><h1>Pairing Code</h1><p>Use this code in Replit:</p><pre>${escapeHtml(code)}</pre><p>Install command:</p><pre>${escapeHtml(command)}</pre><p><a href="/">Back to dashboard</a></p></body></html>`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/shutdown") {
    if (!isLocalRequest(req)) {
      return sendJson(res, 403, { error: "Shutdown is only available from localhost." });
    }
    store.log("shutdown", "Local dashboard requested shutdown.");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex Link Shutting Down</title><style>body{font-family:system-ui;margin:32px;line-height:1.5}</style></head><body><h1>Codex Link is shutting down</h1><p>The controller and public tunnel are stopping. You can close this tab.</p><p>Start it again from <code>control-center\\Start Codex Link.cmd</code>.</p></body></html>`);
    setTimeout(async () => {
      await stopTunnelProcesses();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    }, 150).unref();
    return;
  }

  if (req.method === "POST" && url.pathname === "/tasks") {
    const form = parseForm(await readRawBody(req));
    const app = store.getApp(form.appId);
    if (!app || !form.prompt?.trim()) return sendJson(res, 400, { error: "App and prompt are required." });
    const task = store.createTask({ appId: app.id, prompt: form.prompt.trim() });
    store.updateTask(task.id, { status: "running", summary: "Waiting for worker heartbeat." });
    store.addTaskEvent(task.id, "task", `Task started for ${app.name}.`);
    store.enqueueWorkerCommand(app.id, {
      taskId: task.id,
      type: "run_command",
      command: "git",
      args: ["status", "--short"]
    });
    store.addTaskEvent(task.id, "worker", "Queued initial git status command.");
    return redirect(res, `/tasks/${task.id}`);
  }

  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(taskPage(taskMatch[1]));
    return;
  }

  const taskEventsMatch = url.pathname.match(/^\/tasks\/([^/]+)\/events$/);
  if (req.method === "GET" && taskEventsMatch) return taskSse(req, res, taskEventsMatch[1]);

  const queueCommandMatch = url.pathname.match(/^\/tasks\/([^/]+)\/queue-command$/);
  if (req.method === "POST" && queueCommandMatch) {
    const task = store.data.tasks[queueCommandMatch[1]];
    if (!task) return sendJson(res, 404, { error: "Task not found." });
    const form = parseForm(await readRawBody(req));
    const args = String(form.args || "").split(/\s+/).filter(Boolean);
    store.enqueueWorkerCommand(task.appId, { taskId: task.id, type: "run_command", command: form.command || "git", args });
    store.addTaskEvent(task.id, "worker", `Queued command: ${form.command || "git"} ${args.join(" ")}`);
    return redirect(res, `/tasks/${task.id}`);
  }

  const stopTaskMatch = url.pathname.match(/^\/tasks\/([^/]+)\/stop$/);
  if (req.method === "POST" && stopTaskMatch) {
    store.updateTask(stopTaskMatch[1], { status: "stopped", summary: "Stopped by user." });
    store.addTaskEvent(stopTaskMatch[1], "task", "Task stopped by user.");
    return redirect(res, `/tasks/${stopTaskMatch[1]}`);
  }

  if (req.method === "POST" && url.pathname === "/api/pair") {
    const body = await readBody(req);
    const pairing = store.consumePairingCode(body.pairingCode);
    if (!pairing) return sendJson(res, 400, { error: "Invalid or expired pairing code." });
    const controllerUrl = externalBaseUrl(req);
    const app = store.registerApp({ report: body.report, controllerUrl, pairingCode: pairing.code });
    const rememberedStrategy = store.getRememberedStrategy(createSetupPlan({
      report: body.report,
      controllerUrl,
      appId: app.id,
      appToken: app.token
    }).patternKey);
    const plan = createSetupPlan({ report: body.report, controllerUrl, appId: app.id, appToken: app.token, rememberedStrategy });
    const mode = body.mode || plan.recommendedMode;
    const savedPlan = store.recordSetupPlan(app.id, plan, mode);
    const split = actionsForMode(plan, mode);
    store.log("pair", `App paired: ${app.name}`, { appId: app.id, planId: plan.id, mode });
    return sendJson(res, 200, {
      app: { id: app.id, token: app.token, name: app.name },
      plan: savedPlan,
      actions: split
    });
  }

  if (req.method === "POST" && url.pathname === "/api/heartbeat") {
    const app = authenticate(req);
    if (!app) return sendJson(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    store.updateApp(app.id, {
      status: "online",
      workerMode: body.workerMode || app.workerMode,
      lastHeartbeatAt: new Date().toISOString(),
      lastWorker: body
    });
    const commands = store.takeWorkerCommands(app.id);
    for (const command of commands) {
      if (command.taskId) {
        store.addTaskEvent(command.taskId, "worker", `Sent worker command: ${command.type}`, { commandId: command.id });
      }
    }
    return sendJson(res, 200, { ok: true, commands });
  }

  if (req.method === "POST" && url.pathname === "/api/command-results") {
    const app = authenticate(req);
    if (!app) return sendJson(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    for (const item of body.results || []) {
      const command = store.completeWorkerCommand(app.id, item.commandId, item.result);
      if (command?.taskId) {
        const output = [item.result?.stdout, item.result?.stderr, item.result?.error].filter(Boolean).join("\n").trim();
        store.addTaskEvent(command.taskId, item.result?.ok === false ? "worker_error" : "worker_result", output || `Worker command ${command.type} completed.`, {
          commandId: command.id,
          result: item.result
        });
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/setup-result") {
    const app = authenticate(req);
    if (!app) return sendJson(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    const plan = store.updateSetupPlan(body.planId, {
      status: body.ok ? "applied" : "failed",
      appliedResults: body.results || [],
      error: body.error || null
    });
    if (body.ok && plan) store.rememberSuccessfulSetup(plan);
    store.log(body.ok ? "setup_applied" : "setup_failed", `${app.name}: setup ${body.ok ? "applied" : "failed"}`, { appId: app.id, planId: body.planId });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  try {
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await htmlPage(req));
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/pairing-code" || url.pathname === "/shutdown" || url.pathname.startsWith("/tasks")) return await handleApi(req, res, url);
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  store.log("controller", `Codex Link controller listening on ${BASE_URL}`);
  console.log(`Codex Link controller listening on ${BASE_URL}`);
  startTelegramBot({
    token: process.env.TELEGRAM_BOT_TOKEN,
    ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID,
    store
  });
});
