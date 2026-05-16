const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MAX_FILE_BYTES = 120_000;

function exists(root, file) {
  return fs.existsSync(path.join(root, file));
}

function readText(root, file) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) return null;
  const stat = fs.statSync(fullPath);
  if (stat.size > MAX_FILE_BYTES) return null;
  return fs.readFileSync(fullPath, "utf8");
}

function readJson(root, file) {
  const text = readText(root, file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function execGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function isReplitInternalRemote(url) {
  return /^git:\/\/gitsafe[:/]/i.test(url)
    || /^git\+ssh:\/\/git@ssh\.worf\.replit\.dev[:/]/i.test(url)
    || /^ssh:\/\/git@ssh\.worf\.replit\.dev[:/]/i.test(url);
}

function parseRemotes(text) {
  const byName = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, direction] = match;
    const record = byName.get(name) || { name, fetchUrl: null, pushUrl: null, internal: false };
    if (direction === "fetch") record.fetchUrl = url;
    if (direction === "push") record.pushUrl = url;
    record.internal = record.internal || isReplitInternalRemote(url);
    byName.set(name, record);
  }
  return Array.from(byName.values()).map((remote) => ({
    ...remote,
    url: remote.fetchUrl || remote.pushUrl,
    internal: remote.internal || isReplitInternalRemote(remote.fetchUrl || remote.pushUrl || "")
  }));
}

function chooseExternalRemote(remotes) {
  const external = remotes.filter((remote) => remote.url && !remote.internal);
  return external.find((remote) => remote.name === "origin") || external[0] || null;
}

function gitInfo(root) {
  try {
    const branch = execGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const remotes = parseRemotes(execGit(root, ["remote", "-v"]));
    const externalRemote = chooseExternalRemote(remotes);
    const dirty = execGit(root, ["status", "--porcelain"]).length > 0;
    return {
      present: true,
      branch,
      remote: externalRemote?.url || null,
      remoteName: externalRemote?.name || null,
      externalRemote,
      remotes,
      hasInternalReplitRemote: remotes.some((remote) => remote.internal),
      hasExternalRemote: Boolean(externalRemote),
      dirty
    };
  } catch {
    return {
      present: exists(root, ".git"),
      branch: null,
      remote: null,
      remoteName: null,
      externalRemote: null,
      remotes: [],
      hasInternalReplitRemote: false,
      hasExternalRemote: false,
      dirty: null
    };
  }
}

function listTopLevel(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".git") && entry.name !== "node_modules")
    .slice(0, 80)
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
}

function detectPackageManager(root) {
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  if (exists(root, "package-lock.json")) return "npm";
  if (exists(root, "bun.lockb")) return "bun";
  if (exists(root, "package.json")) return "npm";
  if (exists(root, "uv.lock")) return "uv";
  if (exists(root, "poetry.lock")) return "poetry";
  if (exists(root, "requirements.txt")) return "pip";
  return "unknown";
}

function detectAppType(root, pkg) {
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.next) return "next";
    if (deps.vite) return "vite";
    if (deps.express) return "node-express";
    return "node";
  }
  if (exists(root, "pyproject.toml") || exists(root, "requirements.txt") || exists(root, "main.py") || exists(root, "app.py")) {
    const req = readText(root, "requirements.txt") || "";
    if (req.toLowerCase().includes("flask")) return "python-flask";
    if (req.toLowerCase().includes("fastapi")) return "python-fastapi";
    return "python";
  }
  if (exists(root, "index.html")) return "static";
  return "unknown";
}

function extractReplitRun(replitText) {
  if (!replitText) return null;
  const match = replitText.match(/^\s*run\s*=\s*["'](.+?)["']\s*$/m);
  return match ? match[1] : null;
}

function scanEnvironment(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const pkg = readJson(absoluteRoot, "package.json");
  const replit = readText(absoluteRoot, ".replit");
  const report = {
    root: absoluteRoot,
    appName: process.env.REPL_SLUG || path.basename(absoluteRoot),
    replit: {
      isReplit: Boolean(process.env.REPL_ID || process.env.REPL_SLUG || process.env.REPL_OWNER),
      id: process.env.REPL_ID || null,
      slug: process.env.REPL_SLUG || null,
      owner: process.env.REPL_OWNER || null,
      run: extractReplitRun(replit),
      hasReplitFile: Boolean(replit)
    },
    appType: detectAppType(absoluteRoot, pkg),
    packageManager: detectPackageManager(absoluteRoot),
    git: gitInfo(absoluteRoot),
    files: {
      topLevel: listTopLevel(absoluteRoot),
      hasPackageJson: Boolean(pkg),
      hasReplit: Boolean(replit),
      hasRequirements: exists(absoluteRoot, "requirements.txt"),
      hasPyproject: exists(absoluteRoot, "pyproject.toml")
    },
    package: pkg ? {
      name: pkg.name || null,
      scripts: pkg.scripts || {},
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {})
    } : null,
    scannedAt: new Date().toISOString()
  };
  return report;
}

module.exports = { scanEnvironment, readText, readJson, gitInfo, parseRemotes, isReplitInternalRemote };
