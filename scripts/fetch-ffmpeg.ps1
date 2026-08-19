# Downloads FFmpeg 8.1 shared GPL binaries for FFME preview and CLI tools.
# Pinned to the n8.1 branch (avutil-60 / avcodec-62) to match Sinaxxr.FFME /
# FFmpeg.AutoGen 8.0 bindings. "master" nightlies use newer sonames and break preview.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $root "tools\ffmpeg"
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$releaseUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip"
$zipPath = Join-Path $env:TEMP "ffmpeg-n81-shared.zip"
$extractPath = Join-Path $env:TEMP "ffmpeg-n81-shared-extract"

Write-Host "Downloading FFmpeg n8.1 shared build..."
Write-Host $releaseUrl
Invoke-WebRequest -Uri $releaseUrl -OutFile $zipPath

if (Test-Path $extractPath) {
    Remove-Item $extractPath -Recurse -Force
}
Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

$binDir = Get-ChildItem -Path $extractPath -Directory | ForEach-Object {
    Join-Path $_.FullName "bin"
} | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $binDir) {
    throw "Could not locate FFmpeg bin directory in archive."
}

# Clear previous install so stale master sonames (e.g. avutil-61) don't linger.
Get-ChildItem $toolsDir -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse

Copy-Item -Path (Join-Path $binDir "*") -Destination $toolsDir -Force
Write-Host "FFmpeg installed to $toolsDir"
Write-Host "Files:"
Get-ChildItem $toolsDir | Select-Object Name

$avutil = Get-ChildItem $toolsDir -Filter "avutil-*.dll" | Select-Object -First 1
if (-not $avutil) {
    throw "avutil DLL missing after install."
}
Write-Host "avutil: $($avutil.Name) (FFME expects avutil-60)"
