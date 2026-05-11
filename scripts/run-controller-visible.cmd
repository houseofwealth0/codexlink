@echo off
cd /d "%~dp0.."
set "CODEX_LINK_PORT=8787"
set "CODEX_LINK_HOST=127.0.0.1"
set "CODEX_LINK_BASE_URL=http://localhost:8787"
if not exist "codex-link-data\logs" mkdir "codex-link-data\logs"
echo Codex Link Controller
echo.
echo Dashboard:
echo   http://localhost:8787/
echo.
echo Keep this window open while using Codex Link.
echo Close this window to stop the controller.
echo.
"C:\Program Files\nodejs\node.exe" packages/controller/src/index.js
echo.
echo Controller stopped.
pause
