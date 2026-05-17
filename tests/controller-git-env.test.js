const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-controller-"));
process.env.CODEX_LINK_DATA_DIR = dataDir;
process.env.CODEX_LINK_PORT = "0";

const { gitEnvForRemote, githubDeployKeyPath, isGithubSshRemote, parseGithubRemote, normalizeRemote } = require("../packages/controller/src/index");

test("controller clone uses workspace deploy key for GitHub SSH remotes", () => {
  const appId = "app-123";
  const keyPath = githubDeployKeyPath(appId);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, "private-key", "utf8");

  const env = gitEnvForRemote(appId, "git@github.com:houseofwealth0/example.git");

  assert.equal(isGithubSshRemote("git@github.com:houseofwealth0/example.git"), true);
  assert.match(env.GIT_SSH_COMMAND, /ssh/);
  assert.match(env.GIT_SSH_COMMAND, /-i/);
  assert.match(env.GIT_SSH_COMMAND, /deploy_key/);
  assert.match(env.GIT_SSH_COMMAND, /IdentitiesOnly=yes/);
});

test("controller clone leaves non-GitHub remotes on default git environment", () => {
  const env = gitEnvForRemote("app-456", "https://github.com/houseofwealth0/example.git");
  assert.equal(env, process.env);
});

test("controller parses GitHub remotes for existing remote deploy key setup", () => {
  assert.deepEqual(parseGithubRemote("git@github.com:houseofwealth0/example.git"), {
    owner: "houseofwealth0",
    repo: "example"
  });
  assert.deepEqual(parseGithubRemote("ssh://git@github.com/houseofwealth0/example.git"), {
    owner: "houseofwealth0",
    repo: "example"
  });
  assert.deepEqual(parseGithubRemote("https://github.com/houseofwealth0/example.git"), {
    owner: "houseofwealth0",
    repo: "example"
  });
});

test("controller normalizes clone-equivalent git remotes", () => {
  assert.equal(
    normalizeRemote("git@github.com:houseofwealth0/example.git"),
    "git@github.com:houseofwealth0/example"
  );
  assert.equal(
    normalizeRemote("git@github.com:houseofwealth0/example"),
    "git@github.com:houseofwealth0/example"
  );
});
