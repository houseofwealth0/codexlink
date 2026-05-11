const http = require("http");
const path = require("path");
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
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

function htmlPage() {
  const apps = store.listApps();
  const tasks = store.listTasks();
  const logs = store.data.logs.slice(0, 30);
  const plans = Object.values(store.data.setupPlans).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const onlineCutoff = Date.now() - 90_000;

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
    h1 { margin: 0; font-size: 24px; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
    section { background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    form { display: inline; }
    button { border: 0; border-radius: 6px; background: #1f6feb; color: white; padding: 9px 12px; cursor: pointer; font-weight: 600; }
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
    <h1>Codex Link</h1>
    <p>Controller: <code>${BASE_URL}</code></p>
  </header>
  <main>
    <section>
      <h2>Pair A Replit App</h2>
      <form method="post" action="/pairing-code">
        <button type="submit">Create Pairing Code</button>
      </form>
      <p>Then run this in Replit with your ngrok URL:</p>
      <pre>npx github:houseofwealth0/codexlink install --controller ${BASE_URL} --pairing-code YOUR_CODE</pre>
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
      <h2>Setup Plans</h2>
      ${plans.slice(0, 8).map((plan) => `<p><span class="pill">${plan.status}</span> <strong>${plan.appName}</strong> ${plan.appType} ${plan.reusedStrategy ? "(reused strategy)" : "(new strategy)"}<br><code>${plan.id}</code></p><pre>${plan.summary}\n\n${plan.actions.map((a) => `${a.risk}: ${a.description} (${a.path})`).join("\n")}</pre>`).join("") || "No setup plans yet."}
    </section>
    <section>
      <h2>Tasks</h2>
      ${tasks.slice(0, 10).map((task) => `<p><span class="pill">${task.status}</span> <code>${task.id}</code> ${task.prompt}</p><pre>${task.summary || ""}\n${task.diff || ""}</pre>`).join("") || "No tasks yet."}
    </section>
    <section>
      <h2>Logs</h2>
      <pre>${logs.map((log) => `${log.createdAt} ${log.type}: ${log.message}`).join("\n")}</pre>
    </section>
  </main>
</body>
</html>`;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/apps") return sendJson(res, 200, { apps: store.listApps() });
  if (req.method === "GET" && url.pathname === "/api/tasks") return sendJson(res, 200, { tasks: store.listTasks() });

  if (req.method === "POST" && url.pathname === "/pairing-code") {
    const code = store.createPairingCode("dashboard");
    res.writeHead(303, { location: `/pairing-code?code=${encodeURIComponent(code.code)}` });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/pairing-code") {
    const code = url.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pairing Code</title><style>body{font-family:system-ui;margin:32px;line-height:1.5}code,pre{font-family:ui-monospace,Consolas,monospace}pre{background:#f2f4f8;padding:16px;border-radius:8px;white-space:pre-wrap}</style></head><body><h1>Pairing Code</h1><p>Use this code in Replit:</p><pre>${code}</pre><p>Install command:</p><pre>npx github:houseofwealth0/codexlink install --controller ${externalBaseUrl(req)} --pairing-code ${code}</pre><p><a href="/">Back to dashboard</a></p></body></html>`);
    return;
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
    return sendJson(res, 200, { ok: true, commands: [] });
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
      res.end(htmlPage());
      return;
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
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
