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
