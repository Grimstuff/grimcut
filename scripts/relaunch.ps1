# Kill any running Grimcut, then start tauri dev.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..
Get-Process grimcut -ErrorAction SilentlyContinue | Stop-Process -Force
npm run tauri dev
