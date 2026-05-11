@echo off
cd /d "%~dp0.."
echo Codex Link ngrok Tunnel
echo.
echo This exposes http://localhost:8787 to Replit through a public HTTPS URL.
echo Copy the https URL shown by ngrok if it changes.
echo Close this window to stop the tunnel.
echo.
if not exist "C:\tmp\ngrok\ngrok.exe" (
  echo ngrok was not found at C:\tmp\ngrok\ngrok.exe
  pause
  exit /b 1
)
"C:\tmp\ngrok\ngrok.exe" http http://127.0.0.1:8787 --config C:\tmp\ngrok\ngrok.yml
echo.
echo ngrok stopped.
pause
