const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyActions } = require("../packages/shared/src/apply-actions");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-test-"));
}

test("writes files and json with backups for existing files", () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { start: "node index.js" } }, null, 2));

  const results = applyActions(root, [
    {
      id: "patch-package-json",
      type: "patch_json",
      path: "package.json",
      patch: { "scripts.codex-link": "codex-link worker" }
    },
    {
      id: "write-config",
      type: "write_json",
      path: ".codex-link/config.json",
      content: { appId: "app-1" }
    }
  ]);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node index.js");
  assert.equal(pkg.scripts["codex-link"], "codex-link worker");
  assert.ok(results[0].backup);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".codex-link/config.json"), "utf8")).appId, "app-1");
});
