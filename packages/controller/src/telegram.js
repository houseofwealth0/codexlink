const { runCodexTask } = require("./codex-runner");

async function telegramRequest(token, method, body) {
  if (!token) return null;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
  return response.json();
}

function formatApps(apps) {
  if (!apps.length) return "No apps connected yet. Send /connect, then run `npx codex-link install` in Replit.";
  return apps.map((app) => {
    const online = app.lastHeartbeatAt && Date.now() - Date.parse(app.lastHeartbeatAt) < 90_000;
    return `${online ? "online" : "offline"} - ${app.name} (${app.appType})`;
  }).join("\n");
}

function startTelegramBot({ token, ownerChatId, store }) {
  if (!token) {
    store.log("telegram", "Telegram disabled: TELEGRAM_BOT_TOKEN is not set.");
    return;
  }

  let offset = 0;
  async function send(chatId, text) {
    return telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown"
    });
  }

  async function handleMessage(message) {
    const chatId = String(message.chat.id);
    if (ownerChatId && String(ownerChatId) !== chatId) {
      await send(chatId, "This Codex Link controller is private.");
      return;
    }

    const text = message.text || "";
    const [command, ...rest] = text.trim().split(/\s+/);

    if (command === "/start" || command === "/help") {
      await send(chatId, "/connect\n/apps\n/status\n/task <app-name> <request>\n/approve <task-id>\n/reject <task-id>\n/logs");
      return;
    }

    if (command === "/connect") {
      const code = store.createPairingCode(chatId);
      await send(chatId, `Pairing code: \`${code.code}\`\nRun: \`npx codex-link install --controller <controller-url> --pairing-code ${code.code}\``);
      return;
    }

    if (command === "/apps") {
      await send(chatId, formatApps(store.listApps()));
      return;
    }

    if (command === "/status") {
      const tasks = store.listTasks().slice(0, 8);
      const body = tasks.length ? tasks.map((task) => `${task.status} - ${task.id.slice(0, 8)} - ${task.prompt.slice(0, 70)}`).join("\n") : "No tasks yet.";
      await send(chatId, body);
      return;
    }

    if (command === "/task") {
      const appName = rest.shift();
      const prompt = rest.join(" ");
      const app = store.listApps().find((candidate) => candidate.name === appName || candidate.id.startsWith(appName || ""));
      if (!app || !prompt) {
        await send(chatId, "Usage: /task <app-name-or-id-prefix> <request>");
        return;
      }
      const task = store.createTask({ appId: app.id, prompt });
      runCodexTask({ task, app, store }).catch((error) => store.updateTask(task.id, { status: "failed", summary: error.message }));
      await send(chatId, `Task queued: \`${task.id}\`\nBranch: \`${task.branch}\``);
      return;
    }

    if (command === "/approve" || command === "/reject") {
      const taskId = rest[0];
      const task = store.data.tasks[taskId] || Object.values(store.data.tasks).find((candidate) => candidate.id.startsWith(taskId || ""));
      if (!task) {
        await send(chatId, "Task not found.");
        return;
      }
      const status = command === "/approve" ? "approved" : "rejected";
      store.updateTask(task.id, { status });
      await send(chatId, `Task ${status}: \`${task.id}\``);
      return;
    }

    if (command === "/logs") {
      await send(chatId, store.data.logs.slice(0, 10).map((log) => `${log.type}: ${log.message}`).join("\n") || "No logs yet.");
    }
  }

  async function poll() {
    try {
      const result = await telegramRequest(token, "getUpdates", { offset, timeout: 25 });
      for (const update of result.result || []) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
      }
    } catch (error) {
      store.log("telegram_error", error.message);
    } finally {
      setTimeout(poll, 1000);
    }
  }

  poll();
}

module.exports = { startTelegramBot, telegramRequest };
