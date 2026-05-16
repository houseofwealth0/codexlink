const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseRemotes, isReplitInternalRemote, gitInfo } = require("../packages/shared/src/env-scan");

test("classifies Replit internal git remotes without treating them as external clone remotes", () => {
  const remotes = parseRemotes([
    "gitsafe-backup  git://gitsafe:5418/backup.git (fetch)",
    "gitsafe-backup  git://gitsafe:5418/backup.git (push)",
    "subrepl-fxoydpja    git+ssh://git@ssh.worf.replit.dev:/home/runner/workspace (fetch)",
    "subrepl-fxoydpja    git+ssh://git@ssh.worf.replit.dev:/home/runner/workspace (push)"
  ].join("\n"));

  assert.equal(remotes.length, 2);
  assert.equal(remotes.every((remote) => remote.internal), true);
  assert.equal(isReplitInternalRemote("git+ssh://git@ssh.worf.replit.dev:/home/runner/workspace"), true);
  assert.equal(isReplitInternalRemote("git@ssh.worf.replit.dev:/home/runner/workspace"), true);
});

test("keeps normal github remotes external while still recording internal remotes", () => {
  const remotes = parseRemotes([
    "origin  https://github.com/example/app.git (fetch)",
    "origin  https://github.com/example/app.git (push)",
    "subrepl-fxoydpja    git+ssh://git@ssh.worf.replit.dev:/home/runner/workspace (fetch)",
    "subrepl-fxoydpja    git+ssh://git@ssh.worf.replit.dev:/home/runner/workspace (push)"
  ].join("\n"));

  const origin = remotes.find((remote) => remote.name === "origin");
  const subrepl = remotes.find((remote) => remote.name === "subrepl-fxoydpja");

  assert.equal(origin.internal, false);
  assert.equal(origin.url, "https://github.com/example/app.git");
  assert.equal(subrepl.internal, true);
});

test("keeps Replit internal remote even when another git command complains", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-git-scan-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "subrepl-fxoydpja", "git+ssh://git@ssh.worf.replit.dev:/home/runner/workspace"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/missing-branch\n", "utf8");

  const info = gitInfo(root);

  assert.equal(info.present, true);
  assert.equal(info.hasInternalReplitRemote, true);
  assert.equal(info.hasExternalRemote, false);
  assert.equal(info.remotes[0].name, "subrepl-fxoydpja");
});
