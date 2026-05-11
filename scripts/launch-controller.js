const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const logDir = path.join(root, "codex-link-data", "logs");
fs.mkdirSync(logDir, { recursive: true });

const out = fs.openSync(path.join(logDir, "controller.log"), "a");
const err = fs.openSync(path.join(logDir, "controller.err.log"), "a");

const child = spawn(process.execPath, ["packages/controller/src/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    CODEX_LINK_PORT: "8787",
    CODEX_LINK_HOST: "127.0.0.1",
    CODEX_LINK_BASE_URL: "http://localhost:8787"
  },
  detached: true,
  stdio: ["ignore", out, err]
});

child.unref();
console.log(child.pid);
