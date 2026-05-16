const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRemotes, isReplitInternalRemote } = require("../packages/shared/src/env-scan");

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
