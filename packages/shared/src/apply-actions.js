const fs = require("fs");
const path = require("path");

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function backupIfExists(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const backupPath = `${fullPath}.codex-link-backup-${Date.now()}`;
  fs.copyFileSync(fullPath, backupPath);
  return path.relative(root, backupPath);
}

function setNested(object, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cursor = object;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function applyAction(root, action) {
  const fullPath = path.join(root, action.path);
  ensureParent(fullPath);
  const backup = backupIfExists(root, action.path);

  if (action.type === "write_file") {
    fs.writeFileSync(fullPath, action.content, "utf8");
    if (action.executable && process.platform !== "win32") {
      fs.chmodSync(fullPath, 0o755);
    }
    return { actionId: action.id, path: action.path, backup, applied: true };
  }

  if (action.type === "write_json") {
    fs.writeFileSync(fullPath, `${JSON.stringify(action.content, null, 2)}\n`, "utf8");
    return { actionId: action.id, path: action.path, backup, applied: true };
  }

  if (action.type === "patch_json") {
    const existing = fs.existsSync(fullPath) ? JSON.parse(fs.readFileSync(fullPath, "utf8")) : {};
    for (const [key, value] of Object.entries(action.patch || {})) {
      setNested(existing, key, value);
    }
    fs.writeFileSync(fullPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    return { actionId: action.id, path: action.path, backup, applied: true };
  }

  throw new Error(`Unsupported setup action type: ${action.type}`);
}

function applyActions(root, actions) {
  return actions.map((action) => applyAction(root, action));
}

module.exports = { applyAction, applyActions };
