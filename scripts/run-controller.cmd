@echo off
cd /d "%~dp0.."
set "CODEX_LINK_PORT=8787"
set "CODEX_LINK_HOST=127.0.0.1"
set "CODEX_LINK_BASE_URL=http://localhost:8787"
if not exist "codex-link-data\logs" mkdir "codex-link-data\logs"
"C:\Program Files\nodejs\node.exe" packages/controller/src/index.js 1>>codex-link-data\logs\controller.log 2>>codex-link-data\logs\controller.err.log
