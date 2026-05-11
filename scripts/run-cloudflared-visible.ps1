$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Cloudflared = "C:\tmp\cloudflared\cloudflared.exe"
$DataDir = Join-Path $Root "codex-link-data"
$LogDir = Join-Path $DataDir "logs"
$TunnelFile = Join-Path $DataDir "tunnel-url.txt"
$LogFile = Join-Path $LogDir "cloudflared.log"

Set-Location $Root
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Remove-Item -LiteralPath $TunnelFile -Force -ErrorAction SilentlyContinue

Write-Host "Codex Link Cloudflare Tunnel"
Write-Host ""
Write-Host "This exposes http://localhost:8787 to Replit through a public HTTPS URL."
Write-Host "Close this window to stop the tunnel."
Write-Host ""

if (-not (Test-Path $Cloudflared)) {
  Write-Host "cloudflared was not found at $Cloudflared"
  Write-Host "Run the Codex setup step to install it."
  Read-Host "Press Enter to close"
  exit 1
}

& $Cloudflared tunnel --url http://127.0.0.1:8787 2>&1 | ForEach-Object {
  $line = "$_"
  Add-Content -LiteralPath $LogFile -Value $line
  $match = [regex]::Match($line, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
  if ($match.Success) {
    Set-Content -LiteralPath $TunnelFile -Value $match.Value
    Write-Host ""
    Write-Host "Public tunnel URL:"
    Write-Host $match.Value
    Write-Host ""
  }
  Write-Host $line
}

Write-Host ""
Write-Host "Cloudflare tunnel stopped."
Read-Host "Press Enter to close"
