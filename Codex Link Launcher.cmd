@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

if not exist "codex-link-data\logs" mkdir "codex-link-data\logs"

echo Starting Codex Link in visible windows...
echo.
echo Controller dashboard:
echo   http://localhost:8787/
echo.

start "Codex Link Controller" "%ROOT%scripts\run-controller-visible.cmd"

if exist "C:\tmp\ngrok\ngrok.exe" (
  start "Codex Link ngrok Tunnel" "%ROOT%scripts\run-ngrok-visible.cmd"
) else (
  echo ngrok not found at C:\tmp\ngrok\ngrok.exe
)

echo.
echo Two visible windows should now be open:
echo   - Codex Link Controller
echo   - Codex Link ngrok Tunnel
echo.
echo Wait a few seconds, then open http://localhost:8787/
pause
