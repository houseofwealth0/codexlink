@echo off
echo Stopping Codex Link controller and ngrok...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Write-Host 'Stopped controller.' } else { Write-Host 'Controller was not running.' }; Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force; Write-Host 'Stopped ngrok if it was running.'"
pause
