const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { Store } = require("./store");
const { startTelegramBot } = require("./telegram");
const { createSetupPlan, actionsForMode } = require("../../shared/src/setup-agent");

const PORT = Number(process.env.CODEX_LINK_PORT || 8787);
const HOST = process.env.CODEX_LINK_HOST || "0.0.0.0";
const BASE_URL = process.env.CODEX_LINK_BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = path.resolve(process.env.CODEX_LINK_DATA_DIR || "codex-link-data");
const WORKSPACES_DIR = path.resolve(process.env.CODEX_LINK_WORKSPACES_DIR || "codex-link-workspaces");

const store = new Store(DATA_DIR);
const activeWorkspaceProcesses = new Map();
const activeCloneProcesses = new Map();

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, shell: needsShell(command), ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code || 0, stdout: stdout || "", stderr: stderr || "", error });
    });
  });
}

function ghCommand() {
  if (process.env.CODEX_LINK_GH_BIN) return process.env.CODEX_LINK_GH_BIN;
  if (process.platform === "win32" && fs.existsSync("C:\\tmp\\gh\\bin\\gh.exe")) return "C:\\tmp\\gh\\bin\\gh.exe";
  return "gh";
}

function codexCommand() {
  if (process.env.CODEX_LINK_CODEX_BIN) return process.env.CODEX_LINK_CODEX_BIN;
  if (process.platform === "win32" && fs.existsSync("C:\\tmp\\codex-cli\\node_modules\\@openai\\codex\\bin\\codex.js")) {
    return "node";
  }
  if (process.platform === "win32" && fs.existsSync("C:\\tmp\\codex-cli\\node_modules\\.bin\\codex.cmd")) {
    return "C:\\tmp\\codex-cli\\node_modules\\.bin\\codex.cmd";
  }
  return "codex";
}

function codexBaseArgs(command) {
  if (command === "node" && process.platform === "win32" && fs.existsSync("C:\\tmp\\codex-cli\\node_modules\\@openai\\codex\\bin\\codex.js")) {
    return ["C:\\tmp\\codex-cli\\node_modules\\@openai\\codex\\bin\\codex.js"];
  }
  return [];
}

function needsShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function gitArgs(repoPath, args) {
  return ["-c", `safe.directory=${repoPath}`, ...args];
}

function queueWorkerPull(appId, remoteName, branch) {
  store.enqueueWorkerCommand(appId, {
    type: "pull_from_github",
    remoteName,
    branch
  });
  store.addWorkspaceTranscript(appId, "publish", "Queued Replit worker to pull the GitHub update.\n");
}

function queueLegacyWorkerPull(appId, remoteName, branch) {
  const sshCommand = "ssh -i .codex-link/github_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new";
  store.enqueueWorkerCommand(appId, {
    type: "run_command",
    purpose: "pull_from_github_fallback",
    command: "sh",
    args: ["-lc", `GIT_SSH_COMMAND=${JSON.stringify(sshCommand)} git pull --rebase --autostash ${remoteName} ${branch}`]
  });
  store.addWorkspaceTranscript(appId, "publish", "Queued legacy Replit worker Git pull fallback.\n");
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function openVisibleCommand(command, args = []) {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const psCommand = `& ${powershellQuote(command)} ${args.map(powershellQuote).join(" ")}`;
      const child = spawn("cmd.exe", [
        "/d",
        "/s",
        "/c",
        "start",
        "GitHub Login - Codex Link",
        "powershell.exe",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        psCommand
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      let settled = false;
      child.on("error", (error) => {
        settled = true;
        resolve({ ok: false, error: error.message });
      });
      child.on("spawn", () => {
        setTimeout(() => {
          if (!settled) resolve({ ok: true, pid: child.pid });
        }, 250).unref();
      });
      child.unref();
    });
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return Promise.resolve({ ok: true, pid: child.pid });
}

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

function statusClass(status) {
  if (["ready", "github_login_started"].includes(status)) return "online";
  if (["failed", "not_available"].includes(status)) return "offline";
  return "active";
}

function gitSyncNextAction(gitSync = {}) {
  switch (gitSync.status) {
    case "internal_git_detected":
      return "Click Create / Connect GitHub Remote to create a private GitHub repo and start sync.";
    case "github_repo_creating":
      return "Controller is checking GitHub auth and creating the private repo.";
    case "github_login_started":
      return "Finish the GitHub login window, then click Create / Connect GitHub Remote again.";
    case "replit_remote_configuring":
      return "Controller is preparing the deploy key and Replit remote configuration.";
    case "replit_pushing":
      return "Waiting for the Replit worker to add the remote, commit if needed, and push.";
    case "controller_cloning":
      return "Replit pushed successfully. Controller is cloning the repo locally.";
    case "ready":
      return "GitHub sync is ready. Codex can use the local checkout.";
    case "failed":
      return /gh auth|GitHub CLI/i.test(gitSync.message || gitSync.error || "")
        ? "Click Open GitHub Login, finish auth, then retry GitHub sync."
        : "Review the latest error, then retry GitHub sync.";
    case "not_available":
      return "No Git repository was detected in Replit yet.";
    default:
      return "Waiting for GitHub sync to start.";
  }
}

function needsGithubLogin(gitSync = {}) {
  return gitSync.status === "github_login_started"
    || (gitSync.status === "failed" && /gh auth|GitHub CLI/i.test(gitSync.message || gitSync.error || ""));
}

function renderGitSyncTimeline(gitSync = {}) {
  const history = gitSync.history || [];
  if (!history.length) return `<li class="timeline-empty">No GitHub sync events yet.</li>`;
  return history.slice(-20).reverse().map((item) => `
    <li class="${escapeHtml(statusClass(item.status))}">
      <div class="timeline-dot"></div>
      <div>
        <div class="timeline-head"><strong>${escapeHtml(item.status || "event")}</strong><span>${escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleString() : "")}</span></div>
        <div>${escapeHtml(item.message || "")}</div>
      </div>
    </li>
  `).join("");
}

function workspaceName(app) {
  return app?.displayName || app?.replit?.slug || app?.name || "Workspace";
}

function safeSegment(value) {
  return String(value || "workspace")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

function hasInternalReplitGit(app) {
  return Boolean(app?.git?.hasInternalReplitRemote
    || app?.lastReport?.git?.hasInternalReplitRemote
    || (app?.git?.remotes || []).some((remote) => remote.internal)
    || (app?.lastReport?.git?.remotes || []).some((remote) => remote.internal));
}

function defaultWorkspacePath(app) {
  const report = app.lastReport || {};
  const replit = report.replit || {};
  const label = `${safeSegment(replit.owner || "replit")}-${safeSegment(replit.slug || app.name)}-${app.id.slice(0, 8)}`;
  return path.join(WORKSPACES_DIR, label);
}

function normalizeRemote(remote) {
  return String(remote || "").trim().replace(/\.git$/i, "");
}

function workerReconnectCommand(app, controllerUrl) {
  if (!app || !controllerUrl || controllerUrl === BASE_URL) return null;
  return `npx --yes github:houseofwealth0/codexlink#main reconnect --controller ${controllerUrl} --app-id ${app.id}`;
}

function needsWorkerReconnect(app, publicUrl) {
  return Boolean(app?.controllerUrl && publicUrl && app.controllerUrl !== publicUrl);
}

function validateLocalPath(localPath) {
  if (!localPath) return { ok: false, error: "Local path is required." };
  const resolved = path.resolve(localPath);
  try {
    if (!fs.existsSync(resolved)) return { ok: false, error: "Local path does not exist." };
    if (!fs.statSync(resolved).isDirectory()) return { ok: false, error: "Local path must be a directory." };
    return { ok: true, path: resolved };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function updateCloneStatus(appId, patch) {
  const app = store.getApp(appId);
  if (!app) return null;
  const next = {
    ...(app.cloneStatus || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  return store.updateApp(appId, { cloneStatus: next });
}

function updateGitSync(appId, patch) {
  const updated = store.updateGitSync(appId, patch);
  if (updated?.gitSync?.message) store.addWorkspaceTranscript(appId, "git-sync", `${updated.gitSync.message}\n`);
  return updated;
}

function githubDeployKeyPath(appId) {
  return path.join(DATA_DIR, "github-keys", appId, "deploy_key");
}

function isGithubSshRemote(remote) {
  return /^git@github\.com:/i.test(String(remote || ""))
    || /^ssh:\/\/git@github\.com\//i.test(String(remote || ""));
}

function parseGithubRemote(remote) {
  const value = String(remote || "").trim();
  let match = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
  match = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
  match = value.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
  return null;
}

function gitEnvForRemote(appId, remote) {
  if (!isGithubSshRemote(remote)) return process.env;
  const keyPath = githubDeployKeyPath(appId);
  if (!fs.existsSync(keyPath)) return process.env;
  const sshCommand = [
    "ssh",
    "-i",
    keyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ].map((part) => /\s/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part).join(" ");
  return {
    ...process.env,
    GIT_SSH_COMMAND: sshCommand
  };
}

async function gitRemoteMatches(checkoutPath, remote) {
  const wanted = normalizeRemote(remote);
  if (!wanted || !fs.existsSync(path.join(checkoutPath, ".git"))) return false;
  const result = await execFilePromise("git", ["-C", checkoutPath, "remote", "-v"], {
    env: gitEnvForRemote("", remote)
  });
  if (!result.ok) return false;
  return result.stdout.split(/\r?\n/).some((line) => normalizeRemote(line.split(/\s+/)[1]) === wanted);
}

async function findExistingCheckoutByRemote(remote) {
  if (!remote || !fs.existsSync(WORKSPACES_DIR)) return null;
  const entries = fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(WORKSPACES_DIR, entry.name);
    if (await gitRemoteMatches(candidate, remote)) return candidate;
  }
  return null;
}

function defaultGithubRepoName(app) {
  const report = app.lastReport || {};
  const replit = report.replit || {};
  return `codexlink-${safeSegment(replit.owner || "replit")}-${safeSegment(replit.slug || app.name)}`.slice(0, 90);
}

async function checkGhAuth() {
  const status = await execFilePromise(ghCommand(), ["auth", "status"]);
  if (!status.ok) return { ok: false, message: "GitHub CLI is not installed or not logged in. Run gh auth login on this PC." };
  const user = await execFilePromise(ghCommand(), ["api", "user", "--jq", ".login"]);
  if (!user.ok || !user.stdout.trim()) return { ok: false, message: "Could not read GitHub user from gh. Run gh auth login on this PC." };
  return { ok: true, owner: user.stdout.trim() };
}

async function createGithubRepo(owner, baseName, appId) {
  const candidates = [baseName, `${baseName}-${appId.slice(0, 8)}`];
  let lastError = null;
  for (const repo of candidates) {
    const created = await execFilePromise(ghCommand(), ["api", "user/repos", "-f", `name=${repo}`, "-F", "private=true"]);
    if (created.ok) {
      return {
        owner,
        repo,
        repoUrl: `https://github.com/${owner}/${repo}`,
        sshUrl: `git@github.com:${owner}/${repo}.git`
      };
    }
    lastError = (created.stderr || created.stdout || created.error?.message || "").trim();
    if (!/already exists|Name already exists|HTTP 422/i.test(lastError)) break;
  }
  return { error: lastError || "GitHub repo creation failed." };
}

async function ensureDeployKey(appId, owner, repo) {
  const dir = path.join(DATA_DIR, "github-keys", appId);
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, "deploy_key");
  const publicKeyPath = `${keyPath}.pub`;
  if (!fs.existsSync(keyPath) || !fs.existsSync(publicKeyPath)) {
    const keygen = await execFilePromise("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `codex-link-${appId}`, "-f", keyPath]);
    if (!keygen.ok) return { ok: false, error: keygen.stderr || keygen.stdout || "ssh-keygen failed." };
  }
  const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
  const privateKey = fs.readFileSync(keyPath, "utf8");
  const title = `Codex Link ${appId.slice(0, 8)}`;
  const added = await execFilePromise(ghCommand(), ["api", `repos/${owner}/${repo}/keys`, "-f", `title=${title}`, "-f", `key=${publicKey}`, "-F", "read_only=false"]);
  if (!added.ok && !/key is already in use|already_exists|422/i.test(`${added.stderr}\n${added.stdout}`)) {
    return { ok: false, error: added.stderr || added.stdout || "Could not add deploy key." };
  }
  return { ok: true, publicKey, privateKey };
}

async function ensureControllerCloneAccess(appId, remote) {
  if (!isGithubSshRemote(remote)) return { ok: true };
  if (fs.existsSync(githubDeployKeyPath(appId))) return { ok: true };
  const parsed = parseGithubRemote(remote);
  if (!parsed) return { ok: false, error: "Could not parse GitHub SSH remote for deploy key setup." };
  updateGitSync(appId, {
    status: "controller_cloning",
    message: `External GitHub remote exists. Creating controller deploy key for ${parsed.owner}/${parsed.repo}...`,
    owner: parsed.owner,
    repo: parsed.repo,
    repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
    sshUrl: `git@github.com:${parsed.owner}/${parsed.repo}.git`
  });
  const deployKey = await ensureDeployKey(appId, parsed.owner, parsed.repo);
  if (!deployKey.ok) return deployKey;
  updateGitSync(appId, {
    status: "controller_cloning",
    message: "Controller deploy key is ready. Cloning on controller..."
  });
  return { ok: true };
}

async function startGitSync(appId) {
  const app = store.getApp(appId);
  if (!app) return { ok: false, error: "Workspace not found." };
  if (app.git?.hasExternalRemote && (app.git.externalRemote?.url || app.git.remote)) {
    const remote = app.git.externalRemote?.url || app.git.remote;
    updateGitSync(appId, {
      status: "controller_cloning",
      message: "External Git remote already exists.",
      repoUrl: remote,
      sshUrl: remote,
      remoteName: app.git.remoteName || app.git.externalRemote?.name || "origin"
    });
    const access = await ensureControllerCloneAccess(appId, remote);
    if (!access.ok) {
      updateGitSync(appId, { status: "failed", message: access.error, error: access.error });
      return { ok: false, error: access.error };
    }
    await startWorkspaceClone(appId);
    return { ok: true, alreadyReady: true };
  }
  if (!app.git?.present && !app.lastReport?.git?.present) {
    updateGitSync(appId, { status: "failed", message: "No Git repository detected in Replit.", error: "No Git repository detected." });
    return { ok: false, error: "No Git repository detected." };
  }

  updateGitSync(appId, {
    status: "github_repo_creating",
    message: "Checking GitHub CLI login and creating a private repo...",
    startedAt: new Date().toISOString(),
    error: null
  });
  const gh = await checkGhAuth();
  if (!gh.ok) {
    updateGitSync(appId, { status: "failed", message: gh.message, error: gh.message });
    return { ok: false, error: gh.message };
  }
  updateGitSync(appId, {
    status: "github_repo_creating",
    message: `GitHub CLI is logged in as ${gh.owner}. Creating private repo...`
  });

  const repoResult = await createGithubRepo(gh.owner, defaultGithubRepoName(app), appId);
  if (repoResult.error) {
    updateGitSync(appId, { status: "failed", message: repoResult.error, error: repoResult.error });
    return { ok: false, error: repoResult.error };
  }

  updateGitSync(appId, {
    status: "replit_remote_configuring",
    message: `Created private GitHub repo ${repoResult.owner}/${repoResult.repo}. Creating deploy key...`,
    owner: repoResult.owner,
    repo: repoResult.repo,
    repoUrl: repoResult.repoUrl,
    sshUrl: repoResult.sshUrl,
    remoteName: "codexlink",
    createdAt: new Date().toISOString()
  });

  const deployKey = await ensureDeployKey(appId, repoResult.owner, repoResult.repo);
  if (!deployKey.ok) {
    updateGitSync(appId, { status: "failed", message: deployKey.error, error: deployKey.error });
    return { ok: false, error: deployKey.error };
  }
  updateGitSync(appId, {
    status: "replit_remote_configuring",
    message: "Writable deploy key added to GitHub. Waiting for the Replit worker to receive setup command..."
  });

  const branch = app.git?.branch && app.git.branch !== "HEAD" ? app.git.branch : "main";
  store.enqueueWorkerCommand(appId, {
    type: "configure_github_remote",
    sshUrl: repoResult.sshUrl,
    remoteName: "codexlink",
    targetBranch: branch,
    bootstrapMessage: "Codex Link bootstrap snapshot",
    deployPrivateKey: deployKey.privateKey
  });
  updateGitSync(appId, {
    status: "replit_pushing",
    message: "Queued Replit worker to configure GitHub remote and push current workspace.",
    branch
  });
  return { ok: true };
}

async function startWorkspaceClone(appId) {
  const app = store.getApp(appId);
  if (!app) return { ok: false, error: "Workspace not found." };
  if (activeCloneProcesses.has(appId)) return { ok: true, running: true };

  const remote = app.git?.externalRemote?.url || app.git?.remote || app.lastReport?.git?.externalRemote?.url || app.lastReport?.git?.remote;
  if (!remote) {
    if (hasInternalReplitGit(app)) {
      updateCloneStatus(appId, {
        status: "external_remote_needed",
        remote: null,
        path: null,
        message: "Replit internal Git detected. Use GitHub Sync to create an external remote."
      });
      store.addWorkspaceTranscript(appId, "clone", "Automatic clone paused: Replit internal Git is present, but no external clone remote was found.");
      return { ok: false, error: "External Git remote needed." };
    }
    updateCloneStatus(appId, {
      status: "skipped",
      remote: null,
      path: null,
      message: "No Git remote detected; automatic clone is unavailable."
    });
    store.addWorkspaceTranscript(appId, "git-sync", "Waiting for GitHub Sync to create a controller-ready remote.");
    return { ok: false, error: "No Git remote detected." };
  }

  const existing = validateLocalPath(app.localPath);
  if (existing.ok && fs.existsSync(path.join(existing.path, ".git"))) {
    updateCloneStatus(appId, {
      status: "ready",
      remote,
      path: existing.path,
      message: "Local checkout already exists."
    });
    return { ok: true, path: existing.path, alreadyReady: true };
  }

  const matchingCheckout = await findExistingCheckoutByRemote(remote);
  if (matchingCheckout) {
    store.updateWorkspace(appId, { localPath: matchingCheckout });
    updateCloneStatus(appId, {
      status: "ready",
      remote,
      path: matchingCheckout,
      message: "Reused existing controller checkout for this Git remote."
    });
    updateGitSync(appId, {
      status: "ready",
      message: "GitHub sync ready. Reused existing controller checkout."
    });
    store.addWorkspaceTranscript(appId, "clone", `Reused existing controller checkout at ${matchingCheckout}\n`);
    return { ok: true, path: matchingCheckout, alreadyReady: true, reused: true };
  }

  const targetPath = defaultWorkspacePath(app);
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  if (fs.existsSync(targetPath)) {
    const entries = fs.readdirSync(targetPath);
    if (fs.existsSync(path.join(targetPath, ".git"))) {
      store.updateWorkspace(appId, { localPath: targetPath });
      updateCloneStatus(appId, {
        status: "ready",
        remote,
        path: targetPath,
        message: "Local checkout already exists."
      });
      return { ok: true, path: targetPath, alreadyReady: true };
    }
    if (entries.length > 0) {
      updateCloneStatus(appId, {
        status: "failed",
        remote,
        path: targetPath,
        message: "Target folder exists and is not an empty Git checkout."
      });
      return { ok: false, error: "Target folder exists and is not an empty Git checkout." };
    }
  }

  updateCloneStatus(appId, {
    status: "running",
    remote,
    path: targetPath,
    message: "Cloning local checkout..."
  });
  store.addWorkspaceTranscript(appId, "clone", `Cloning ${remote} into ${targetPath}\n`);
  if (isGithubSshRemote(remote) && fs.existsSync(githubDeployKeyPath(appId))) {
    store.addWorkspaceTranscript(appId, "clone", "Using this workspace's GitHub deploy key for controller clone.\n");
  }

  const child = spawn("git", ["clone", remote, targetPath], {
    cwd: WORKSPACES_DIR,
    env: gitEnvForRemote(appId, remote),
    shell: false
  });
  activeCloneProcesses.set(appId, child);

  child.stdout.on("data", (chunk) => {
    store.addWorkspaceTranscript(appId, "clone", chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    store.addWorkspaceTranscript(appId, "clone", chunk.toString());
  });
  child.on("error", (error) => {
    activeCloneProcesses.delete(appId);
    updateCloneStatus(appId, {
      status: "failed",
      remote,
      path: targetPath,
      message: error.message
    });
    updateGitSync(appId, { status: "failed", message: `Controller clone failed: ${error.message}`, error: error.message });
    store.addWorkspaceTranscript(appId, "error", `Clone failed: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    activeCloneProcesses.delete(appId);
    if (code === 0) {
      store.updateWorkspace(appId, { localPath: targetPath });
      updateCloneStatus(appId, {
        status: "ready",
        remote,
        path: targetPath,
        message: "Local checkout ready."
      });
      updateGitSync(appId, { status: "ready", message: "GitHub sync ready. Local checkout is available.", repoUrl: (store.getApp(appId)?.gitSync || {}).repoUrl });
      store.addWorkspaceTranscript(appId, "clone", `Local checkout ready at ${targetPath}\n`);
      return;
    }
    const message = `git clone exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}.`;
    updateCloneStatus(appId, {
      status: "failed",
      remote,
      path: targetPath,
      message
    });
    updateGitSync(appId, { status: "failed", message: `Controller clone failed: ${message}`, error: message });
    store.addWorkspaceTranscript(appId, "error", `Clone failed: ${message}`);
  });
  return { ok: true, path: targetPath, pid: child.pid };
}

function startCodexForWorkspace(appId, prompt) {
  const app = store.getApp(appId);
  if (!app) return { ok: false, error: "Workspace not found." };
  if (activeWorkspaceProcesses.has(appId)) return { ok: false, error: "Codex is already running for this workspace." };
  const validation = validateLocalPath(app.localPath);
  if (!validation.ok) return validation;

  const command = codexCommand();
  const args = [...codexBaseArgs(command), "exec", "--cd", validation.path, "--sandbox", "workspace-write", prompt];
  store.updateWorkspaceSession(appId, {
    status: "running",
    startedAt: new Date().toISOString(),
    stoppedAt: null
  });
  store.addWorkspaceTranscript(appId, "system", `Starting: ${command} ${args.join(" ")}`);

  const child = spawn(command, args, {
    cwd: validation.path,
    env: process.env,
    shell: needsShell(command),
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeWorkspaceProcesses.set(appId, child);
  store.updateWorkspaceSession(appId, { activePid: child.pid });

  child.stdout.on("data", (chunk) => {
    store.addWorkspaceTranscript(appId, "stdout", chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    store.addWorkspaceTranscript(appId, "stderr", chunk.toString());
  });
  child.on("error", (error) => {
    store.addWorkspaceTranscript(appId, "error", error.message);
    store.updateWorkspaceSession(appId, { status: "failed", activePid: null, stoppedAt: new Date().toISOString() });
    activeWorkspaceProcesses.delete(appId);
  });
  child.on("exit", (code, signal) => {
    store.addWorkspaceTranscript(appId, "system", `Codex exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}.`);
    store.updateWorkspaceSession(appId, {
      status: code === 0 ? "idle" : "failed",
      activePid: null,
      stoppedAt: new Date().toISOString()
    });
    activeWorkspaceProcesses.delete(appId);
  });
  return { ok: true, pid: child.pid };
}

async function publishWorkspaceChanges(appId) {
  const app = store.getApp(appId);
  if (!app) return { ok: false, error: "Workspace not found." };
  const validation = validateLocalPath(app.localPath);
  if (!validation.ok) return validation;
  const remote = app.git?.externalRemote?.url || app.git?.remote || app.gitSync?.sshUrl || app.cloneStatus?.remote;
  if (!remote) return { ok: false, error: "No Git remote configured for publishing." };
  const branch = app.gitSync?.branch || app.git?.branch || "main";
  const remoteName = app.git?.remoteName || app.gitSync?.remoteName || "codexlink";
  const env = gitEnvForRemote(appId, remote);

  store.addWorkspaceTranscript(appId, "publish", "Publishing local Codex changes to GitHub...\n");
  await execFilePromise("git", gitArgs(validation.path, ["config", "user.name", "Codex Link"]), { cwd: validation.path });
  await execFilePromise("git", gitArgs(validation.path, ["config", "user.email", "codex-link@local"]), { cwd: validation.path });

  const status = await execFilePromise("git", gitArgs(validation.path, ["status", "--porcelain"]), { cwd: validation.path });
  if (!status.ok) return { ok: false, error: status.stderr || status.stdout || "Could not read Git status." };
  if (!status.stdout.trim()) {
    store.addWorkspaceTranscript(appId, "publish", "No local changes to publish. Re-queuing Replit pull check.\n");
    queueWorkerPull(appId, remoteName, branch);
    return { ok: true, skipped: true };
  }

  let result = await execFilePromise("git", gitArgs(validation.path, ["add", "-A"]), { cwd: validation.path });
  if (!result.ok) return { ok: false, error: result.stderr || result.stdout || "git add failed." };
  result = await execFilePromise("git", gitArgs(validation.path, ["commit", "-m", "Codex Link task update"]), { cwd: validation.path });
  if (!result.ok) return { ok: false, error: result.stderr || result.stdout || "git commit failed." };
  store.addWorkspaceTranscript(appId, "publish", result.stdout || "Committed local changes.\n");

  result = await execFilePromise("git", gitArgs(validation.path, ["push", "origin", `HEAD:${branch}`]), { cwd: validation.path, env });
  if (!result.ok) return { ok: false, error: result.stderr || result.stdout || "git push failed." };
  store.addWorkspaceTranscript(appId, "publish", result.stdout || result.stderr || "Pushed local changes to GitHub.\n");

  queueWorkerPull(appId, remoteName, branch);
  return { ok: true };
}

function stopCodexForWorkspace(appId) {
  const child = activeWorkspaceProcesses.get(appId);
  if (!child) {
    store.updateWorkspaceSession(appId, { status: "idle", activePid: null, stoppedAt: new Date().toISOString() });
    return { ok: true, stopped: false };
  }
  child.kill();
  activeWorkspaceProcesses.delete(appId);
  store.addWorkspaceTranscript(appId, "system", "Stop requested.");
  store.updateWorkspaceSession(appId, { status: "stopping", activePid: null, stoppedAt: new Date().toISOString() });
  return { ok: true, stopped: true };
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
    .workspace-list { display: grid; gap: 10px; }
    .workspace-card { display: grid; grid-template-columns: minmax(180px, 1.1fr) minmax(180px, 1fr) minmax(160px, .9fr) minmax(150px, .8fr); gap: 12px; align-items: start; padding: 14px; border: 1px solid #edf0f5; border-radius: 8px; color: inherit; text-decoration: none; }
    .workspace-card:hover { border-color: #9db7ee; background: #f8fbff; }
    .workspace-title { font-weight: 700; font-size: 15px; }
    .muted { color: #687386; }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f2f4f8; padding: 12px; border-radius: 6px; }
    .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: #eef2ff; color: #243b7a; }
    .online { background: #e8f7ee; color: #14532d; }
    .offline { background: #f3f4f6; color: #4b5563; }
    .active { background: #e0f2fe; color: #075985; }
    @media (prefers-color-scheme: dark) {
      body { background: #101319; color: #eef2f7; }
      header, section { background: #171b23; border-color: #2a303b; }
      .workspace-card { border-color: #272d37; }
      .workspace-card:hover { border-color: #3d65b1; background: #151b27; }
      pre { background: #11151c; }
    }
    @media (max-width: 840px) {
      .workspace-card { grid-template-columns: 1fr; }
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
      <h2>Workspaces</h2>
      <div class="workspace-list">
        ${apps.map((app) => {
            const online = app.lastHeartbeatAt && Date.parse(app.lastHeartbeatAt) > onlineCutoff;
            const report = app.lastReport || {};
            const replit = report.replit || {};
            const git = app.git || {};
            const clone = app.cloneStatus || {};
            const gitSync = app.gitSync || {};
            const cloneClass = clone.status === "ready" ? "online" : ["failed", "external_remote_needed"].includes(clone.status) ? "offline" : "";
            const reconnectNeeded = needsWorkerReconnect(app, publicTunnelUrl);
            const tags = (app.tags || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("");
            return `<a class="workspace-card" href="/workspaces/${escapeHtml(app.id)}">
              <div>
                <div><span class="pill ${online ? "online" : "offline"}">${online ? "online" : "offline"}</span></div>
                <div class="workspace-title">${escapeHtml(workspaceName(app))}</div>
                <div class="muted"><code>${escapeHtml(app.id)}</code></div>
                <div class="tags">${reconnectNeeded ? `<span class="pill offline">reconnect needed</span>` : ""}${tags}</div>
              </div>
              <div>
                <strong>${escapeHtml(replit.owner || "unknown owner")}/${escapeHtml(replit.slug || app.name || "unknown")}</strong>
                <div class="muted">${escapeHtml(app.appType || "unknown")} - ${escapeHtml(app.packageManager || "unknown package manager")}</div>
              </div>
              <div>
                <strong>${git.hasExternalRemote ? "External Git connected" : git.hasInternalReplitRemote ? "Replit internal Git" : git.present ? "Git present" : "Git missing"}</strong>
                <div class="muted"><code>${escapeHtml(git.branch || "no branch")}</code></div>
                <div class="muted"><code>${escapeHtml(git.remote || "no remote")}</code></div>
              </div>
              <div>
                <strong>Last heartbeat</strong>
                <div class="muted">${escapeHtml(app.lastHeartbeatAt || "never")}</div>
                <div><span class="pill ${escapeHtml(statusClass(gitSync.status))}">git: ${escapeHtml(gitSync.status || "unknown")}</span></div>
                <div class="muted">${escapeHtml(gitSync.message || "No GitHub sync status yet.")}</div>
                <div><span class="pill ${cloneClass}">clone: ${escapeHtml(clone.status || "unknown")}</span></div>
              </div>
            </a>`;
          }).join("") || `<p>No apps yet. Use <code>/connect</code> in Telegram, then run <code>npx codex-link install</code>.</p>`}
      </div>
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

async function workspacePage(appId, req) {
  const app = store.getApp(appId);
  if (!app) {
    return `<!doctype html><html><body><h1>Workspace not found</h1><p><a href="/">Back to dashboard</a></p></body></html>`;
  }
  const session = store.getWorkspaceSession(appId);
  const onlineCutoff = Date.now() - 90_000;
  const online = app.lastHeartbeatAt && Date.parse(app.lastHeartbeatAt) > onlineCutoff;
  const report = app.lastReport || {};
  const replit = report.replit || {};
  const git = app.git || {};
  const clone = app.cloneStatus || {};
  const gitSync = app.gitSync || {};
  const pathStatus = validateLocalPath(app.localPath);
  const cloneClass = clone.status === "ready" ? "online" : ["failed", "external_remote_needed"].includes(clone.status) ? "offline" : "";
  const publicControllerUrl = await installBaseUrl(req);
  const reconnectNeeded = needsWorkerReconnect(app, publicControllerUrl);
  const reconnectCommand = workerReconnectCommand(app, publicControllerUrl);
  const tags = (app.tags || []).join(", ");
  const notes = app.notes || "";
  const localPath = app.localPath || "";
  const autoSyncAvailable = Boolean(hasInternalReplitGit(app) || gitSync.status === "internal_git_detected" || gitSync.status === "failed" || gitSync.status === "github_login_started");
  const githubLoginCommand = `${ghCommand()} auth login`;
  const promptDisabled = pathStatus.ok ? "" : "disabled";
  const promptHint = pathStatus.ok
    ? `Codex will run locally in ${pathStatus.path}`
    : autoSyncAvailable
      ? "Codex will be enabled after GitHub Sync creates the local checkout automatically."
      : pathStatus.error;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(workspaceName(app))} - Codex Link</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fb; color: #1b1f2a; }
    header { padding: 22px 24px; background: #fff; border-bottom: 1px solid #dfe3ea; }
    main { max-width: 1280px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 18px; align-items: start; }
    h1 { margin: 6px 0 4px; font-size: 24px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    section { background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; padding: 16px; }
    label { display: grid; gap: 6px; font-weight: 600; }
    input, textarea { width: 100%; box-sizing: border-box; font: inherit; border: 1px solid #cfd6e3; border-radius: 6px; padding: 9px; background: #fff; color: inherit; }
    textarea { resize: vertical; }
    button { border: 0; border-radius: 6px; background: #1f6feb; color: white; padding: 9px 12px; cursor: pointer; font-weight: 600; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .danger { background: #b42318; }
    .secondary { background: #475467; }
    .header-row, .controls { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .terminal-wrap { display: grid; grid-template-rows: minmax(360px, 62vh) auto; overflow: hidden; }
    #terminal { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; background: #0d1117; color: #e6edf3; padding: 14px; border-radius: 8px; font: 13px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .prompt-form { display: grid; gap: 10px; margin-top: 12px; }
    .side { display: grid; gap: 14px; }
    .meta { display: grid; gap: 8px; font-size: 14px; }
    .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: #eef2ff; color: #243b7a; }
    .online { background: #e8f7ee; color: #14532d; }
    .offline { background: #f3f4f6; color: #4b5563; }
    .active { background: #e0f2fe; color: #075985; }
    .warning { background: #fff7ed; border-color: #fed7aa; }
    .muted { color: #687386; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    form.inline { display: inline; }
    .timeline { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 10px; }
    .timeline li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 13px; }
    .timeline-dot { width: 9px; height: 9px; margin-top: 5px; border-radius: 999px; background: #98a2b3; }
    .timeline li.online .timeline-dot { background: #16a34a; }
    .timeline li.offline .timeline-dot { background: #b42318; }
    .timeline li.active .timeline-dot { background: #0284c7; }
    .timeline-head { display: flex; justify-content: space-between; gap: 8px; color: #475467; }
    .timeline-head span { white-space: nowrap; font-size: 12px; }
    .timeline-empty { color: #687386; }
    .next-action { padding: 10px; border: 1px solid #dbeafe; background: #eff6ff; border-radius: 6px; color: #1e3a8a; }
    @media (prefers-color-scheme: dark) {
      body { background: #101319; color: #eef2f7; }
      header, section { background: #171b23; border-color: #2a303b; }
      input, textarea { background: #11151c; border-color: #333b49; }
      .warning { background: #2a2117; border-color: #704214; }
    }
    @media (max-width: 960px) {
      main { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <p><a href="/">Back to dashboard</a></p>
        <h1>${escapeHtml(workspaceName(app))}</h1>
        <p><span class="pill ${online ? "online" : "offline"}">${online ? "worker online" : "worker offline"}</span> <span id="session-status" class="pill">${escapeHtml(session.status)}</span> <span id="git-sync-status" class="pill ${escapeHtml(statusClass(gitSync.status))}">git: ${escapeHtml(gitSync.status || "unknown")}</span> <span id="clone-status" class="pill ${cloneClass}">clone: ${escapeHtml(clone.status || "unknown")}</span></p>
      </div>
      <div class="controls">
        <form class="inline" method="post" action="/workspaces/${escapeHtml(app.id)}/publish">
          <button type="submit" ${pathStatus.ok ? "" : "disabled"}>Publish to Replit</button>
        </form>
        <form class="inline" method="post" action="/workspaces/${escapeHtml(app.id)}/clear" onsubmit="return confirm('Clear this workspace transcript?');">
          <button class="secondary" type="submit">Clear Transcript</button>
        </form>
        <form class="inline" method="post" action="/workspaces/${escapeHtml(app.id)}/stop">
          <button class="danger" type="submit">Stop Session</button>
        </form>
      </div>
    </div>
  </header>
  <main>
    <section>
      <h2>Live Codex Terminal</h2>
      <div class="terminal-wrap">
        <pre id="terminal"></pre>
        <form class="prompt-form" method="post" action="/workspaces/${escapeHtml(app.id)}/prompt">
          <label>Prompt
            <textarea name="prompt" rows="4" ${promptDisabled} placeholder="Tell Codex what to do in this workspace..."></textarea>
          </label>
          <div class="header-row">
            <span class="muted">${escapeHtml(promptHint)}</span>
            <button type="submit" ${promptDisabled}>Start Codex Run</button>
          </div>
        </form>
      </div>
    </section>
    <aside class="side">
      ${reconnectNeeded && reconnectCommand ? `<section class="warning"><h2>Worker Reconnect Needed</h2><p>This workspace was installed with an older public tunnel URL. Run this once in that Replit workspace to update the existing worker without creating a duplicate app.</p><pre>${escapeHtml(reconnectCommand)}</pre></section>` : ""}
      ${pathStatus.ok ? "" : autoSyncAvailable ? `<section class="warning"><h2>GitHub Sync Needed</h2><p>This Replit workspace has internal Git. Codex Link will create a private GitHub remote, push the Replit project, and prepare the controller workspace automatically.</p></section>` : `<section class="warning"><h2>GitHub Remote Needed</h2><p>Codex Link needs a controller-ready Git remote before Codex can run against this project.</p></section>`}
      <section>
        <h2>GitHub Sync</h2>
        <div class="meta">
          <div><strong>Current step</strong><br><span id="git-sync-message">${escapeHtml(gitSync.message || "No GitHub sync status yet.")}</span></div>
          <div class="next-action"><strong>Next</strong><br><span id="git-sync-next">${escapeHtml(gitSyncNextAction(gitSync))}</span></div>
          <div><strong>Repo</strong><br><code id="git-sync-repo">${escapeHtml(gitSync.repoUrl || "not created yet")}</code></div>
          <div><strong>Branch</strong><br><code id="git-sync-branch">${escapeHtml(gitSync.branch || git.branch || "not selected yet")}</code></div>
          <div><strong>Remote</strong><br><code>${escapeHtml(gitSync.remoteName || "codexlink")}</code></div>
        </div>
        <ol id="git-sync-timeline" class="timeline">${renderGitSyncTimeline(gitSync)}</ol>
        <form id="git-login-form" class="prompt-form" method="post" action="/workspaces/${escapeHtml(app.id)}/github-login" ${needsGithubLogin(gitSync) ? "" : "hidden"}>
          <button type="submit">Open GitHub Login</button>
        </form>
        <p id="git-login-fallback" class="muted" ${needsGithubLogin(gitSync) ? "" : "hidden"}>If no window appears, run this on this PC:<br><code>${escapeHtml(githubLoginCommand)}</code></p>
        <form class="prompt-form" method="post" action="/workspaces/${escapeHtml(app.id)}/git-sync/start">
          <button id="git-sync-button" type="submit">${gitSync.status === "failed" ? "Retry GitHub Sync" : "Create / Connect GitHub Remote"}</button>
        </form>
      </section>
      <section>
        <h2>Controller Workspace</h2>
        <div class="meta">
          <div><strong>Status</strong><br><span id="clone-message">${escapeHtml(clone.message || "No clone status yet.")}</span></div>
          <div><strong>Remote</strong><br><code>${escapeHtml(clone.remote || git.remote || "no remote detected")}</code></div>
          <div><strong>Path</strong><br><code id="clone-path">${escapeHtml(clone.path || app.localPath || "not ready yet")}</code></div>
        </div>
        ${autoSyncAvailable && !pathStatus.ok ? "" : `<form class="prompt-form" method="post" action="/workspaces/${escapeHtml(app.id)}/clone"><button type="submit">Prepare Controller Workspace</button></form>`}
      </section>
      <section>
        <h2>Workspace Settings</h2>
        <form class="prompt-form" method="post" action="/workspaces/${escapeHtml(app.id)}/settings">
          <label>Name
            <input name="displayName" value="${escapeHtml(workspaceName(app))}" />
          </label>
          <label>Tags
            <input name="tags" value="${escapeHtml(tags)}" placeholder="client, production, node" />
          </label>
          <label>Advanced: Controller Path
            <input name="localPath" value="${escapeHtml(localPath)}" placeholder="D:\\Users\\colan\\Documents\\my-app" />
          </label>
          <label>Notes
            <textarea name="notes" rows="4">${escapeHtml(notes)}</textarea>
          </label>
          <button type="submit">Save Workspace</button>
        </form>
      </section>
      <section>
        <h2>Replit Worker</h2>
        <div class="meta">
          <div><strong>Replit</strong><br><code>${escapeHtml(replit.owner || "unknown")}/${escapeHtml(replit.slug || app.name || "unknown")}</code></div>
          <div><strong>Type</strong><br>${escapeHtml(app.appType || "unknown")} - ${escapeHtml(app.packageManager || "unknown")}</div>
          <div><strong>Git</strong><br>${git.hasExternalRemote ? "external remote ready" : git.hasInternalReplitRemote ? "Replit internal Git only" : git.present ? "present without external remote" : "missing"} - <code>${escapeHtml(git.branch || "no branch")}</code><br><code>${escapeHtml(git.remote || "no external remote")}</code></div>
          <div><strong>Last heartbeat</strong><br>${escapeHtml(app.lastHeartbeatAt || "never")}</div>
          <div><strong>Worker mode</strong><br>${escapeHtml(app.workerMode || "workspace")}</div>
        </div>
      </section>
    </aside>
  </main>
  <script>
    const terminal = document.getElementById('terminal');
    const status = document.getElementById('session-status');
    const initialGitBranch = ${JSON.stringify(git.branch || "not selected yet")};
    function syncClass(syncStatus) {
      if (syncStatus === 'ready' || syncStatus === 'github_login_started') return 'online';
      if (syncStatus === 'failed' || syncStatus === 'not_available') return 'offline';
      return 'active';
    }
    function gitSyncNextAction(gitSync) {
      switch (gitSync?.status) {
        case 'internal_git_detected':
          return 'Click Create / Connect GitHub Remote to create a private GitHub repo and start sync.';
        case 'github_repo_creating':
          return 'Controller is checking GitHub auth and creating the private repo.';
        case 'github_login_started':
          return 'Finish the GitHub login window, then click Create / Connect GitHub Remote again.';
        case 'replit_remote_configuring':
          return 'Controller is preparing the deploy key and Replit remote configuration.';
        case 'replit_pushing':
          return 'Waiting for the Replit worker to add the remote, commit if needed, and push.';
        case 'controller_cloning':
          return 'Replit pushed successfully. Controller is cloning the repo locally.';
        case 'ready':
          return 'GitHub sync is ready. Codex can use the local checkout.';
        case 'failed':
          return /gh auth|GitHub CLI/i.test(gitSync.message || gitSync.error || '')
            ? 'Click Open GitHub Login, finish auth, then retry GitHub sync.'
            : 'Review the latest error, then retry GitHub sync.';
        case 'not_available':
          return 'No Git repository was detected in Replit yet.';
        default:
          return 'Waiting for GitHub sync to start.';
      }
    }
    function needsGithubLogin(gitSync) {
      return gitSync?.status === 'github_login_started'
        || (gitSync?.status === 'failed' && /gh auth|GitHub CLI/i.test(gitSync.message || gitSync.error || ''));
    }
    function renderGitTimeline(history) {
      const list = document.getElementById('git-sync-timeline');
      if (!list) return;
      const items = (history || []).slice(-20).reverse();
      if (!items.length) {
        list.innerHTML = '<li class="timeline-empty">No GitHub sync events yet.</li>';
        return;
      }
      list.innerHTML = '';
      for (const item of items) {
        const row = document.createElement('li');
        row.className = syncClass(item.status);
        const dot = document.createElement('div');
        dot.className = 'timeline-dot';
        const body = document.createElement('div');
        const head = document.createElement('div');
        head.className = 'timeline-head';
        const strong = document.createElement('strong');
        strong.textContent = item.status || 'event';
        const time = document.createElement('span');
        time.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
        const message = document.createElement('div');
        message.textContent = item.message || '';
        head.append(strong, time);
        body.append(head, message);
        row.append(dot, body);
        list.append(row);
      }
    }
    function appendEvent(event) {
      const when = new Date(event.createdAt).toLocaleTimeString();
      const prefix = '[' + when + '] ' + event.type + ': ';
      terminal.textContent += prefix + event.text;
      if (!event.text.endsWith('\\n')) terminal.textContent += '\\n';
      terminal.scrollTop = terminal.scrollHeight;
    }
    const source = new EventSource('/workspaces/${escapeHtml(app.id)}/events');
    source.onmessage = (message) => {
      const payload = JSON.parse(message.data);
      if (payload.session?.status) status.textContent = payload.session.status;
      if (payload.app?.cloneStatus) {
        const clone = payload.app.cloneStatus;
        const cloneStatus = document.getElementById('clone-status');
        const cloneMessage = document.getElementById('clone-message');
        const clonePath = document.getElementById('clone-path');
        cloneStatus.textContent = 'clone: ' + (clone.status || 'unknown');
        cloneStatus.className = 'pill ' + (clone.status === 'ready' ? 'online' : clone.status === 'failed' || clone.status === 'external_remote_needed' ? 'offline' : '');
        cloneMessage.textContent = clone.message || 'No clone status yet.';
        clonePath.textContent = clone.path || 'not ready yet';
      }
      if (payload.app?.gitSync) {
        const gitSync = payload.app.gitSync;
        const gitStatus = document.getElementById('git-sync-status');
        const gitMessage = document.getElementById('git-sync-message');
        const gitNext = document.getElementById('git-sync-next');
        const gitRepo = document.getElementById('git-sync-repo');
        const gitBranch = document.getElementById('git-sync-branch');
        const loginForm = document.getElementById('git-login-form');
        const loginFallback = document.getElementById('git-login-fallback');
        const syncButton = document.getElementById('git-sync-button');
        gitStatus.textContent = 'git: ' + (gitSync.status || 'unknown');
        gitStatus.className = 'pill ' + syncClass(gitSync.status);
        gitMessage.textContent = gitSync.message || 'No GitHub sync status yet.';
        gitNext.textContent = gitSyncNextAction(gitSync);
        gitRepo.textContent = gitSync.repoUrl || 'not created yet';
        gitBranch.textContent = gitSync.branch || initialGitBranch;
        if (loginForm) loginForm.hidden = !needsGithubLogin(gitSync);
        if (loginFallback) loginFallback.hidden = !needsGithubLogin(gitSync);
        if (syncButton) syncButton.textContent = gitSync.status === 'failed' ? 'Retry GitHub Sync' : 'Create / Connect GitHub Remote';
        renderGitTimeline(gitSync.history);
      }
      for (const event of payload.events || []) appendEvent(event);
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

function workspaceSse(req, res, appId) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  let lastIndex = 0;
  const send = () => {
    const session = store.getWorkspaceSession(appId);
    const transcript = session.transcript || [];
    const nextEvents = transcript.slice(lastIndex);
    lastIndex = transcript.length;
    const app = store.getApp(appId);
    res.write(`data: ${JSON.stringify({ app: app ? { id: app.id, cloneStatus: app.cloneStatus, gitSync: app.gitSync, localPath: app.localPath } : null, session, events: nextEvents })}\n\n`);
  };
  send();
  const interval = setInterval(send, 1000);
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

  const workspaceMatch = url.pathname.match(/^\/workspaces\/([^/]+)$/);
  if (req.method === "GET" && workspaceMatch) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await workspacePage(workspaceMatch[1], req));
    return;
  }

  const workspaceEventsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/events$/);
  if (req.method === "GET" && workspaceEventsMatch) {
    if (!store.getApp(workspaceEventsMatch[1])) return sendJson(res, 404, { error: "Workspace not found." });
    return workspaceSse(req, res, workspaceEventsMatch[1]);
  }

  const workspaceSettingsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/settings$/);
  if (req.method === "POST" && workspaceSettingsMatch) {
    const form = parseForm(await readRawBody(req));
    const app = store.updateWorkspace(workspaceSettingsMatch[1], {
      displayName: form.displayName,
      tags: form.tags,
      notes: form.notes,
      localPath: form.localPath
    });
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    const localPathStatus = validateLocalPath(app.localPath);
    if (localPathStatus.ok) {
      updateCloneStatus(app.id, {
        status: "ready",
        remote: app.git?.remote || app.cloneStatus?.remote || null,
        path: localPathStatus.path,
        message: "Local checkout configured."
      });
    }
    store.addWorkspaceTranscript(app.id, "system", "Workspace settings updated.");
    return redirect(res, `/workspaces/${app.id}`);
  }

  const workspaceCloneMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/clone$/);
  if (req.method === "POST" && workspaceCloneMatch) {
    const app = store.getApp(workspaceCloneMatch[1]);
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    await startWorkspaceClone(app.id);
    return redirect(res, `/workspaces/${app.id}`);
  }

  const workspaceGitSyncMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/git-sync\/start$/);
  if (req.method === "POST" && workspaceGitSyncMatch) {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "GitHub sync setup is only available from localhost." });
    const app = store.getApp(workspaceGitSyncMatch[1]);
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    await startGitSync(app.id);
    return redirect(res, `/workspaces/${app.id}`);
  }

  const workspaceGithubLoginMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/github-login$/);
  if (req.method === "POST" && workspaceGithubLoginMatch) {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "GitHub login is only available from localhost." });
    const app = store.getApp(workspaceGithubLoginMatch[1]);
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    const opened = await openVisibleCommand(ghCommand(), ["auth", "login"]);
    if (opened.ok) {
      updateGitSync(app.id, {
        status: "github_login_started",
        message: "Opening a visible GitHub login window. Complete it, then click Create / Connect GitHub Remote again.",
        error: null
      });
    } else {
      updateGitSync(app.id, {
        status: "failed",
        message: `Could not open GitHub login: ${opened.error}`,
        error: opened.error
      });
    }
    return redirect(res, `/workspaces/${app.id}`);
  }

  const workspacePromptMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/prompt$/);
  if (req.method === "POST" && workspacePromptMatch) {
    const app = store.getApp(workspacePromptMatch[1]);
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    const form = parseForm(await readRawBody(req));
    const prompt = String(form.prompt || "").trim();
    if (!prompt) {
      store.addWorkspaceTranscript(app.id, "error", "Prompt is required.");
      return redirect(res, `/workspaces/${app.id}`);
    }
    store.addWorkspaceTranscript(app.id, "prompt", prompt);
    const started = startCodexForWorkspace(app.id, prompt);
    if (!started.ok) store.addWorkspaceTranscript(app.id, "error", started.error);
    return redirect(res, `/workspaces/${app.id}`);
  }

  const workspacePublishMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/publish$/);
  if (req.method === "POST" && workspacePublishMatch) {
    const app = store.getApp(workspacePublishMatch[1]);
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    const result = await publishWorkspaceChanges(app.id);
    if (!result.ok) store.addWorkspaceTranscript(app.id, "error", `Publish failed: ${result.error}`);
    return redirect(res, `/workspaces/${app.id}`);
  }

  const workspaceStopMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/stop$/);
  if (req.method === "POST" && workspaceStopMatch) {
    const app = store.getApp(workspaceStopMatch[1]);
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    stopCodexForWorkspace(app.id);
    return redirect(res, `/workspaces/${app.id}`);
  }

  const workspaceClearMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/clear$/);
  if (req.method === "POST" && workspaceClearMatch) {
    const app = store.getApp(workspaceClearMatch[1]);
    if (!app) return sendJson(res, 404, { error: "Workspace not found." });
    store.clearWorkspaceTranscript(app.id);
    store.addWorkspaceTranscript(app.id, "system", "Transcript cleared.");
    return redirect(res, `/workspaces/${app.id}`);
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
    await startWorkspaceClone(app.id);
    const pairedApp = store.getApp(app.id);
    return sendJson(res, 200, {
      app: { id: app.id, token: app.token, name: app.name, cloneStatus: pairedApp?.cloneStatus || app.cloneStatus },
      plan: savedPlan,
      actions: split
    });
  }

  if (req.method === "POST" && url.pathname === "/api/reconnect") {
    const app = authenticate(req);
    if (!app) return sendJson(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    const controllerUrl = body.controllerUrl || externalBaseUrl(req);
    const patch = {
      controllerUrl,
      status: "reconnected",
      lastReconnectAt: new Date().toISOString()
    };
    if (body.report) {
      patch.lastReport = body.report;
      patch.git = body.report.git || app.git;
      patch.appType = body.report.appType || app.appType;
      patch.packageManager = body.report.packageManager || app.packageManager;
    }
    const updated = store.updateApp(app.id, patch);
    store.log("reconnect", `App reconnected: ${app.name}`, { appId: app.id, controllerUrl });
    return sendJson(res, 200, { ok: true, app: { id: updated.id, name: updated.name, controllerUrl: updated.controllerUrl } });
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
      } else if (command.type === "configure_github_remote") {
        store.addWorkspaceTranscript(app.id, "git-sync", "Sent GitHub remote setup command to Replit worker.\n");
        updateGitSync(app.id, {
          status: "replit_pushing",
          message: "Replit worker received the GitHub remote setup command."
        });
      } else if (command.type === "pull_from_github") {
        store.addWorkspaceTranscript(app.id, "publish", "Sent GitHub pull command to Replit worker.\n");
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
      if (command?.type === "configure_github_remote") {
        if (item.result?.ok === false) {
          updateGitSync(app.id, {
            status: "failed",
            message: item.result.error || item.result.stderr || "Replit GitHub push failed.",
            error: item.result.error || item.result.stderr || "Replit GitHub push failed."
          });
        } else {
          const gitSync = app.gitSync || {};
          updateGitSync(app.id, {
            status: "controller_cloning",
            message: "Replit pushed to GitHub. Cloning on controller..."
          });
          store.updateApp(app.id, {
            git: {
              ...(app.git || {}),
              remote: gitSync.sshUrl || command.sshUrl,
              remoteName: command.remoteName || "codexlink",
              hasExternalRemote: true,
              externalRemote: { name: command.remoteName || "codexlink", url: gitSync.sshUrl || command.sshUrl, internal: false }
            }
          });
          updateCloneStatus(app.id, {
            status: "pending",
            remote: gitSync.sshUrl || command.sshUrl,
            message: "Replit pushed to GitHub. Controller clone queued."
          });
          await startWorkspaceClone(app.id);
        }
      }
      if (command?.type === "pull_from_github") {
        const output = [item.result?.stdout, item.result?.stderr, item.result?.error].filter(Boolean).join("\n").trim();
        if (item.result?.ok === false) {
          store.addWorkspaceTranscript(app.id, "error", `Replit pull failed: ${output || "unknown error"}`);
          if (/Unknown command type pull_from_github/i.test(output)) {
            queueLegacyWorkerPull(app.id, command.remoteName || "codexlink", command.branch || "main");
          }
        } else {
          store.addWorkspaceTranscript(app.id, "publish", output || "Replit worker pulled the GitHub update.\n");
        }
      }
      if (command?.purpose === "pull_from_github_fallback") {
        const output = [item.result?.stdout, item.result?.stderr, item.result?.error].filter(Boolean).join("\n").trim();
        if (item.result?.ok === false) {
          store.addWorkspaceTranscript(app.id, "error", `Legacy Replit pull failed: ${output || "unknown error"}`);
        } else {
          store.addWorkspaceTranscript(app.id, "publish", output || "Legacy Replit worker pulled the GitHub update.\n");
        }
      }
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
    if (url.pathname.startsWith("/api/")
      || url.pathname === "/pairing-code"
      || url.pathname === "/shutdown"
      || url.pathname.startsWith("/tasks")
      || url.pathname.startsWith("/workspaces")) return await handleApi(req, res, url);
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    store.log("controller", `Codex Link controller listening on ${BASE_URL}`);
    console.log(`Codex Link controller listening on ${BASE_URL}`);
    startTelegramBot({
      token: process.env.TELEGRAM_BOT_TOKEN,
      ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID,
      store
    });
  });
}

module.exports = {
  gitEnvForRemote,
  githubDeployKeyPath,
  isGithubSshRemote,
  parseGithubRemote,
  normalizeRemote
};
