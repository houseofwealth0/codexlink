$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$Root = Split-Path -Parent $PSScriptRoot
$Node = "C:\Program Files\nodejs\node.exe"
$Cloudflared = "C:\tmp\cloudflared\cloudflared.exe"
$GitHubCli = "C:\tmp\gh\bin\gh.exe"
$DataDir = Join-Path $Root "codex-link-data"
$LogDir = Join-Path $DataDir "logs"
$TunnelFile = Join-Path $DataDir "tunnel-url.txt"
$ControllerLog = Join-Path $LogDir "controller.log"
$ControllerErr = Join-Path $LogDir "controller.err.log"
$TunnelLog = Join-Path $LogDir "cloudflared.log"
$Controller = $null
$Tunnel = $null

function Write-LogLine {
  param([string]$Path, [string]$Line)
  try {
    [System.IO.File]::AppendAllText($Path, $Line + [Environment]::NewLine)
  } catch {}
}

function Stop-Children {
  Write-Host ""
  Write-Host "Stopping Codex Link..."
  if ($Tunnel -and -not $Tunnel.HasExited) {
    Stop-Process -Id $Tunnel.Id -Force -ErrorAction SilentlyContinue
  }
  if ($Controller -and -not $Controller.HasExited) {
    Stop-Process -Id $Controller.Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $TunnelFile -Force -ErrorAction SilentlyContinue
}

try {
  Set-Location $Root
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Remove-Item -LiteralPath $TunnelFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $TunnelLog -Force -ErrorAction SilentlyContinue

  Write-Host "Codex Link"
  Write-Host "=========="
  Write-Host ""
  Write-Host "Project: $Root"
  Write-Host "Dashboard: http://localhost:8787/"
  Write-Host ""

  if (-not (Test-Path $Node)) {
    throw "Node was not found at $Node"
  }
  if (-not (Test-Path $Cloudflared)) {
    throw "Cloudflare Tunnel was not found at $Cloudflared"
  }

  $env:CODEX_LINK_PORT = "8787"
  $env:CODEX_LINK_HOST = "127.0.0.1"
  $env:CODEX_LINK_BASE_URL = "http://localhost:8787"

  Write-Host "Starting controller..."
  $Controller = New-Object System.Diagnostics.Process
  $Controller.StartInfo.FileName = $Node
  $Controller.StartInfo.Arguments = "packages/controller/src/index.js"
  $Controller.StartInfo.WorkingDirectory = $Root
  $Controller.StartInfo.UseShellExecute = $false
  $Controller.StartInfo.RedirectStandardOutput = $true
  $Controller.StartInfo.RedirectStandardError = $true
  $Controller.StartInfo.CreateNoWindow = $true
  $Controller.StartInfo.EnvironmentVariables["CODEX_LINK_PORT"] = "8787"
  $Controller.StartInfo.EnvironmentVariables["CODEX_LINK_HOST"] = "127.0.0.1"
  $Controller.StartInfo.EnvironmentVariables["CODEX_LINK_BASE_URL"] = "http://localhost:8787"
  if (Test-Path $GitHubCli) {
    $Controller.StartInfo.EnvironmentVariables["CODEX_LINK_GH_BIN"] = $GitHubCli
  }
  $Controller.Start() | Out-Null
  Register-ObjectEvent -InputObject $Controller -EventName OutputDataReceived -Action {
    if ($EventArgs.Data) {
      [System.IO.File]::AppendAllText($Event.MessageData, $EventArgs.Data + [Environment]::NewLine)
    }
  } -MessageData $ControllerLog | Out-Null
  Register-ObjectEvent -InputObject $Controller -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data) {
      [System.IO.File]::AppendAllText($Event.MessageData, $EventArgs.Data + [Environment]::NewLine)
    }
  } -MessageData $ControllerErr | Out-Null
  $Controller.BeginOutputReadLine()
  $Controller.BeginErrorReadLine()

  Start-Sleep -Seconds 2
  try {
    $health = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/apps -TimeoutSec 5
    Write-Host "Controller OK: $($health.StatusCode)"
  } catch {
    Write-Host "Controller did not answer yet. Check $ControllerErr if this persists."
  }

  Write-Host ""
  Write-Host "Starting Cloudflare Tunnel..."
  $Tunnel = New-Object System.Diagnostics.Process
  $Tunnel.StartInfo.FileName = $Cloudflared
  $Tunnel.StartInfo.Arguments = "tunnel --url http://127.0.0.1:8787"
  $Tunnel.StartInfo.WorkingDirectory = $Root
  $Tunnel.StartInfo.UseShellExecute = $false
  $Tunnel.StartInfo.RedirectStandardOutput = $true
  $Tunnel.StartInfo.RedirectStandardError = $true
  $Tunnel.StartInfo.CreateNoWindow = $true
  $Tunnel.Start() | Out-Null

  $openedDashboard = $false
  $deadline = (Get-Date).AddSeconds(45)
  while (-not $Tunnel.HasExited) {
    $line = $Tunnel.StandardError.ReadLine()
    if ($null -eq $line) {
      $line = $Tunnel.StandardOutput.ReadLine()
    }
    if ($null -eq $line) {
      Start-Sleep -Milliseconds 100
      if ((Get-Date) -gt $deadline) {
        Write-Host "Still waiting for Cloudflare tunnel URL..."
        $deadline = (Get-Date).AddSeconds(45)
      }
      continue
    }

    Write-LogLine $TunnelLog $line
    Write-Host $line
    $match = [regex]::Match($line, "https://(?!api\.)([a-zA-Z0-9-]+)\.trycloudflare\.com")
    if ($match.Success) {
      Set-Content -LiteralPath $TunnelFile -Value $match.Value
      Write-Host ""
      Write-Host "Public tunnel URL:"
      Write-Host $match.Value
      Write-Host ""
      if (-not $openedDashboard) {
        Start-Process "http://localhost:8787/"
        $openedDashboard = $true
      }
    }
  }

  Write-Host ""
  Write-Host "Cloudflare Tunnel exited with code $($Tunnel.ExitCode)."
} catch {
  Write-Host ""
  Write-Host "Codex Link launcher failed:"
  Write-Host $_.Exception.Message
} finally {
  Stop-Children
  Write-Host ""
  Write-Host "Logs:"
  Write-Host "  $ControllerLog"
  Write-Host "  $ControllerErr"
  Write-Host "  $TunnelLog"
  Write-Host ""
  Read-Host "Press Enter to close"
}
