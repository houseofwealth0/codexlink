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

function gitInfo(root) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().length > 0;
    return { present: true, branch, remote, dirty };
  } catch {
    return { present: exists(root, ".git"), branch: null, remote: null, dirty: null };
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

module.exports = { scanEnvironment, readText, readJson };
