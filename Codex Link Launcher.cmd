@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

if not exist "codex-link-data\logs" mkdir "codex-link-data\logs"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start-codex-link-single.ps1"
