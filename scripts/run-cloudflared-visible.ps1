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

try {
  Write-Host "Codex Link Cloudflare Tunnel"
  Write-Host ""
  Write-Host "This exposes http://localhost:8787 to Replit through a public HTTPS URL."
  Write-Host "Close this window to stop the tunnel."
  Write-Host ""

  if (-not (Test-Path $Cloudflared)) {
    throw "cloudflared was not found at $Cloudflared"
  }

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-Host "Starting Cloudflare quick tunnel (attempt $attempt of 3)..."
    Add-Content -LiteralPath $LogFile -Value "=== Cloudflare tunnel attempt $attempt $(Get-Date -Format o) ==="

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

    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
      break
    }

    Write-Host ""
    Write-Host "Cloudflare tunnel exited with code $exitCode."
    if ($attempt -lt 3) {
      Write-Host "Retrying in 3 seconds..."
      Start-Sleep -Seconds 3
    }
  }
} catch {
  Write-Host ""
  Write-Host "Cloudflare tunnel failed:"
  Write-Host $_.Exception.Message
  Add-Content -LiteralPath $LogFile -Value "FAILED: $($_.Exception.Message)"
} finally {
  Write-Host ""
  Write-Host "Cloudflare tunnel window is staying open so you can read what happened."
  Write-Host "Log file: $LogFile"
  Read-Host "Press Enter to close"
}
