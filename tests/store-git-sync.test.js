const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Store } = require("../packages/controller/src/store");

function sampleReport() {
  return {
    appName: "demo-app",
    appType: "node",
    packageManager: "pnpm",
    replit: { owner: "demo", slug: "demo-app" },
    git: {
      present: true,
      branch: "main",
      hasExternalRemote: false,
      hasInternalReplitRemote: true,
      remote: null
    }
  };
}

test("git sync updates append timeline history without duplicating identical messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-store-"));
  const store = new Store(root);
  const app = store.registerApp({ report: sampleReport(), controllerUrl: "http://localhost:8787", pairingCode: "ABC123" });

  assert.equal(app.gitSync.status, "internal_git_detected");
  assert.equal(app.gitSync.history.length, 1);

  store.updateGitSync(app.id, { status: "github_repo_creating", message: "Creating repo..." });
  store.updateGitSync(app.id, { status: "github_repo_creating", message: "Creating repo..." });
  store.updateGitSync(app.id, { status: "replit_pushing", message: "Worker is pushing..." });

  const updated = store.getApp(app.id).gitSync;
  assert.deepEqual(updated.history.map((item) => item.status), [
    "internal_git_detected",
    "github_repo_creating",
    "replit_pushing"
  ]);
});

test("internal Replit git starts in sync-needed state without misleading no-remote clone skip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-store-"));
  const store = new Store(root);
  const app = store.registerApp({ report: sampleReport(), controllerUrl: "http://localhost:8787", pairingCode: "ABC123" });
  const session = store.getWorkspaceSession(app.id);

  assert.equal(app.cloneStatus.status, "external_remote_needed");
  assert.equal(app.gitSync.status, "internal_git_detected");
  assert.equal(session.transcript.some((event) => event.text.includes("Automatic clone skipped: no Git remote detected")), false);
});

test("store migration removes stale no-remote clone transcript for internal Replit git", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-store-"));
  const store = new Store(root);
  const app = store.registerApp({ report: sampleReport(), controllerUrl: "http://localhost:8787", pairingCode: "ABC123" });
  store.addWorkspaceTranscript(app.id, "clone", "Automatic clone skipped: no Git remote detected.");
  store.save();

  const reloaded = new Store(root);
  const session = reloaded.getWorkspaceSession(app.id);

  assert.equal(session.transcript.some((event) => event.text.includes("Automatic clone skipped: no Git remote detected")), false);
  assert.equal(reloaded.getApp(app.id).cloneStatus.status, "external_remote_needed");
});

test("store migration recovers internal Replit git from last report when top-level git is stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-store-"));
  const store = new Store(root);
  const app = store.registerApp({ report: sampleReport(), controllerUrl: "http://localhost:8787", pairingCode: "ABC123" });
  store.updateApp(app.id, {
    git: {
      present: false,
      branch: null,
      remote: null,
      remotes: [],
      hasInternalReplitRemote: false,
      hasExternalRemote: false
    },
    cloneStatus: {
      status: "skipped",
      remote: null,
      path: null,
      message: "No Git remote detected."
    },
    gitSync: {
      status: "not_available",
      message: "No Git repository detected.",
      remoteName: "codexlink",
      updatedAt: new Date().toISOString(),
      history: []
    }
  });
  store.addWorkspaceTranscript(app.id, "clone", "Automatic clone skipped: no Git remote detected.");

  const reloaded = new Store(root);
  const recovered = reloaded.getApp(app.id);
  const session = reloaded.getWorkspaceSession(app.id);

  assert.equal(recovered.git.hasInternalReplitRemote, true);
  assert.equal(recovered.cloneStatus.status, "external_remote_needed");
  assert.equal(recovered.gitSync.status, "internal_git_detected");
  assert.equal(session.transcript.some((event) => event.text.includes("Automatic clone skipped: no Git remote detected")), false);
});
