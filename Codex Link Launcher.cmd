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

if exist "C:\tmp\cloudflared\cloudflared.exe" (
  start "Codex Link Cloudflare Tunnel" powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\run-cloudflared-visible.ps1"
) else (
  echo Cloudflare Tunnel was not found at C:\tmp\cloudflared\cloudflared.exe
)

echo.
echo Two visible windows should now be open:
echo   - Codex Link Controller
echo   - Codex Link Cloudflare Tunnel
echo.
echo Opening dashboard automatically...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:8787/'"
echo Dashboard:
echo   http://localhost:8787/
echo.
echo Control center:
echo   %ROOT%control-center
pause
