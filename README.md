# Codex Link

Codex Link is a local/VPS controller plus a one-shot Replit installer. The goal is to keep Codex auth on one stable machine while each Replit app runs a lightweight worker that reports status, applies approved setup changes, and later receives approved code updates.

## Quick Start

Start the controller locally:

```bash
npm run controller
```

Optional environment:

```bash
CODEX_LINK_PORT=8787
CODEX_LINK_BASE_URL=http://localhost:8787
TELEGRAM_BOT_TOKEN=123:abc
TELEGRAM_OWNER_CHAT_ID=123456
CODEX_LINK_DATA_DIR=./codex-link-data
```

Open the dashboard:

```text
http://localhost:8787
```

Pair an app:

```bash
# In Telegram, send /connect to get a pairing code.
# In the Replit shell:
npx codex-link install --controller http://your-controller:8787
```

For local testing from this repo:

```bash
npm run codex-link -- install --controller http://localhost:8787 --pairing-code YOURCODE --mode safe
```

Install from GitHub inside Replit:

```bash
npx github:houseofwealth0/codexlink install --controller https://YOUR-NGROK-URL --pairing-code YOURCODE
```

## What Exists In This V1

- Controller with app registry, setup plans, setup memory, task records, and dashboard.
- Telegram bot polling for `/connect`, `/apps`, `/status`, `/task`, `/approve`, `/reject`, and `/logs`.
- Agentic setup planner that inspects Replit app facts and chooses safe install actions.
- `codex-link install` command that scans the workspace, pairs with the controller, previews/applies setup actions, and starts a worker.
- Worker loop that heartbeats, receives controller commands, runs safe local commands, and can apply setup actions.
- Branch-and-approve task skeleton that invokes Codex CLI when a repo path is configured on the controller.

## Safety Model

The installer supports three setup modes:

- `ask`: preview all changes and require approval.
- `safe`: apply low-risk config actions automatically and require approval for startup/file edits.
- `auto`: apply the full setup plan immediately.

Every file write action makes a timestamped backup first.
