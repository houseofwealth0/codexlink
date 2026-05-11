@echo off
echo Stopping Codex Link controller and public tunnel...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Write-Host 'Stopped controller.' } else { Write-Host 'Controller was not running.' }; Get-Process ngrok,cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force; Remove-Item 'codex-link-data\tunnel-url.txt' -Force -ErrorAction SilentlyContinue; Write-Host 'Stopped public tunnel if it was running.'"
pause
