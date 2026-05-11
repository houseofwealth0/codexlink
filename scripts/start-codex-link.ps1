param(
  [int]$Port = 8787,
  [string]$NgrokConfig = "C:\tmp\ngrok\ngrok.yml",
  [string]$NgrokExe = "C:\tmp\ngrok\ngrok.exe"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "codex-link-data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$env:CODEX_LINK_PORT = "$Port"
$env:CODEX_LINK_HOST = "127.0.0.1"
$env:CODEX_LINK_BASE_URL = "http://localhost:$Port"

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Write-Host "Controller already listening on port $Port (PID $($existing.OwningProcess))."
} else {
  $controllerLog = Join-Path $LogDir "controller.log"
  $controllerErr = Join-Path $LogDir "controller.err.log"
  $command = "cd /d `"$Root`" && set CODEX_LINK_PORT=$Port && set CODEX_LINK_HOST=127.0.0.1 && set CODEX_LINK_BASE_URL=http://localhost:$Port && node packages/controller/src/index.js > `"$controllerLog`" 2> `"$controllerErr`""
  cmd.exe /c start "codex-link-controller" /min cmd.exe /c $command | Out-Null
  Start-Sleep -Seconds 2
}

$health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/apps"
Write-Host "Controller health: $($health.StatusCode)"

if (Test-Path $NgrokExe) {
  $ngrokAlive = $false
  try {
    $tunnels = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -ErrorAction Stop
    $ngrokAlive = ($tunnels.tunnels | Where-Object { $_.config.addr -eq "http://localhost:$Port" -or $_.config.addr -eq "http://127.0.0.1:$Port" }).Count -gt 0
  } catch {
    $ngrokAlive = $false
  }

  if (-not $ngrokAlive) {
    $ngrokLog = Join-Path $LogDir "ngrok.log"
    $ngrokCommand = "cd /d `"$Root`" && `"$NgrokExe`" http http://127.0.0.1:$Port --config `"$NgrokConfig`" --log=stdout > `"$ngrokLog`" 2>&1"
    cmd.exe /c start "codex-link-ngrok" /min cmd.exe /c $ngrokCommand | Out-Null
    Start-Sleep -Seconds 4
  }

  try {
    $tunnels = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -ErrorAction Stop
    $public = ($tunnels.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1).public_url
    if ($public) {
      Write-Host "ngrok URL: $public"
    } else {
      Write-Host "ngrok is running but no HTTPS tunnel was found yet."
    }
  } catch {
    Write-Host "ngrok tunnel not available: $($_.Exception.Message)"
  }
} else {
  Write-Host "ngrok executable not found at $NgrokExe"
}

Write-Host "Dashboard: http://localhost:$Port/"
