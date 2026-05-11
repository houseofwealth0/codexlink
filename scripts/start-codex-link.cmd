@echo off
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"

set "CODEX_LINK_PORT=8787"
set "CODEX_LINK_HOST=127.0.0.1"
set "CODEX_LINK_BASE_URL=http://localhost:8787"

if not exist "codex-link-data\logs" mkdir "codex-link-data\logs"

for /f %%i in ('node scripts\launch-controller.js') do set "CONTROLLER_PID=%%i"
powershell -NoProfile -Command "Start-Sleep -Seconds 2"

where powershell >nul 2>nul
if %errorlevel%==0 (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/apps; Write-Host ('Controller health: ' + $r.StatusCode) } catch { Write-Host ('Controller health failed: ' + $_.Exception.Message); exit 1 }"
)

if exist "C:\tmp\ngrok\ngrok.exe" (
  start "codex-link-ngrok" /min cmd /c "cd /d "%ROOT%" && C:\tmp\ngrok\ngrok.exe http http://127.0.0.1:8787 --config C:\tmp\ngrok\ngrok.yml --log=stdout 1>codex-link-data\logs\ngrok.log 2>&1"
  powershell -NoProfile -Command "Start-Sleep -Seconds 4"
  powershell -NoProfile -Command "try { $t = Invoke-RestMethod http://127.0.0.1:4040/api/tunnels; $u = ($t.tunnels | ? { $_.proto -eq 'https' } | select -First 1).public_url; Write-Host ('ngrok URL: ' + $u) } catch { Write-Host ('ngrok check failed: ' + $_.Exception.Message) }"
)

echo Dashboard: http://localhost:8787/
