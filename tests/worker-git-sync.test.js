const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configureGithubRemote } = require("../packages/worker/src/worker");

function makeFakeGit(root) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const logPath = path.join(root, "git.log");
  const scriptPath = path.join(bin, "fake-git.js");
  fs.writeFileSync(scriptPath, [
    "const fs = require('fs');",
    "const log = process.env.FAKE_GIT_LOG;",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(log, args.join(' ') + '\\n');",
    "if (args.join(' ') === 'remote get-url codexlink') process.exit(1);",
    "if (args.join(' ') === 'status --porcelain') { console.log(' M file.txt'); process.exit(0); }",
    "process.exit(0);",
    ""
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "git.cmd"), `@echo off\r\nnode "${scriptPath}" %*\r\n`);
  } else {
    const gitPath = path.join(bin, "git");
    fs.writeFileSync(gitPath, `#!/usr/bin/env sh\nnode "${scriptPath}" "$@"\n`);
    fs.chmodSync(gitPath, 0o755);
  }
  return { bin, logPath, gitPath: process.platform === "win32" ? path.join(bin, "git.cmd") : path.join(bin, "git") };
}

test("configure_github_remote writes deploy key, ignores codex-link files, pushes, and redacts results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-worker-"));
  fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
  const fakeGit = makeFakeGit(root);
  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_GIT_LOG;
  const oldGitBin = process.env.CODEX_LINK_GIT_BIN;
  process.env.PATH = `${fakeGit.bin}${path.delimiter}${oldPath}`;
  process.env.FAKE_GIT_LOG = fakeGit.logPath;
  process.env.CODEX_LINK_GIT_BIN = fakeGit.gitPath;
  try {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n";
    const result = await configureGithubRemote({
      sshUrl: "git@github.com:owner/repo.git",
      remoteName: "codexlink",
      targetBranch: "main",
      bootstrapMessage: "Codex Link bootstrap snapshot",
      deployPrivateKey: privateKey
    }, root);

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(root, ".codex-link", "github_deploy_key")), true);
    assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /\.codex-link\//);
    const log = fs.readFileSync(fakeGit.logPath, "utf8");
    assert.match(log, /remote add codexlink git@github.com:owner\/repo.git/);
    assert.match(log, /commit -m Codex Link bootstrap snapshot/);
    assert.match(log, /push -u codexlink HEAD:main/);
    assert.doesNotMatch(JSON.stringify(result), /secret|OPENSSH PRIVATE KEY/);
  } finally {
    process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.FAKE_GIT_LOG;
    else process.env.FAKE_GIT_LOG = oldLog;
    if (oldGitBin === undefined) delete process.env.CODEX_LINK_GIT_BIN;
    else process.env.CODEX_LINK_GIT_BIN = oldGitBin;
  }
});
