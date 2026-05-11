# Codex Link Architecture

## Runtime Shape

Codex Link has three pieces:

- Controller: runs on the user's PC or VPS, owns Codex CLI auth, serves the dashboard, and runs the Telegram bot.
- Installer/worker: installed inside each Replit app with `npx codex-link install`.
- Telegram/dashboard: user-facing control surfaces for pairing, setup review, app status, and task approval.

The Replit app never receives Codex credentials. It only receives an app-scoped worker token.

## Install Flow

1. User sends `/connect` to Telegram.
2. Controller creates a short-lived pairing code.
3. User runs `npx codex-link install --controller <url>` in Replit.
4. Installer scans the environment and posts the report to the controller with the pairing code.
5. Controller creates an app token and setup plan.
6. Installer applies actions based on setup mode.
7. Worker sends a heartbeat.
8. Dashboard and Telegram show the app online.

## Setup Modes

- `ask`: all actions need approval.
- `safe`: safe config actions are automatic; startup/file integration needs approval.
- `auto`: all setup actions are applied immediately.

## Current Protocol

The implementation uses HTTP polling/heartbeat to avoid third-party dependencies. The protocol is intentionally small and can be upgraded to WebSocket later without changing the product model.
