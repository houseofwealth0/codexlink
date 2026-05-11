const { execFile } = require("child_process");
const path = require("path");

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { ...options, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code || 0, stdout, stderr, error: error?.message || null });
    });
  });
}

async function runCodexTask({ task, app, store }) {
  const repoPath = app.localRepoPath || app.lastReport?.root;
  store.updateTask(task.id, { status: "running", summary: "Starting Codex CLI task." });

  const prompt = [
    `You are working on app "${app.name}".`,
    `Create the requested change on branch ${task.branch}.`,
    "Keep changes focused and summarize files changed.",
    "",
    task.prompt
  ].join("\n");

  const gitBranch = await execFilePromise("git", ["checkout", "-B", task.branch], { cwd: repoPath });
  if (!gitBranch.ok) {
    store.updateTask(task.id, { status: "failed", summary: "Could not create task branch.", diff: gitBranch.stderr || gitBranch.stdout });
    return;
  }

  const result = await execFilePromise("codex", ["exec", "--cd", repoPath, "--ask-for-approval", "never", prompt], {
    cwd: repoPath
  });

  const diff = await execFilePromise("git", ["diff", "--stat"], { cwd: repoPath });
  store.updateTask(task.id, {
    status: result.ok ? "waiting_approval" : "failed",
    summary: result.ok ? "Codex finished. Waiting for approval." : "Codex task failed.",
    diff: [result.stdout, result.stderr, diff.stdout].filter(Boolean).join("\n").slice(0, 20_000)
  });
}

module.exports = { runCodexTask };
