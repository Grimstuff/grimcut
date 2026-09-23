# Build Grimcut (NSIS installer + portable folder) and copy to the Desktop.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Building Grimcut (this takes a while)..."
Write-Host "FFmpeg is not bundled - Setup and the app will prompt to install it."
npm run tauri build
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$desktop = [Environment]::GetFolderPath("Desktop")
$setup = Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\nsis\*.exe") -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($setup) {
    $setupDest = Join-Path $desktop "Grimcut Setup.exe"
    Copy-Item $setup.FullName $setupDest -Force
    Write-Host "Installer: $setupDest"
}

$portable = Join-Path $desktop "Grimcut"
if (Test-Path $portable) { Remove-Item $portable -Recurse -Force }
New-Item -ItemType Directory -Force -Path $portable | Out-Null
Copy-Item (Join-Path $root "src-tauri\target\release\grimcut.exe") (Join-Path $portable "Grimcut.exe") -Force
Get-ChildItem (Join-Path $root "src-tauri\target\release") -Filter "*.dll" -ErrorAction SilentlyContinue |
    Copy-Item -Destination $portable -Force
Write-Host "Portable: $portable\Grimcut.exe"
Write-Host "FFmpeg: testers need it on PATH, or the app will prompt to download."
Write-Host "Done."
