# Installs FFmpeg into %LOCALAPPDATA%\Grimcut\ffmpeg (no admin).
$ErrorActionPreference = "Stop"
$dest = Join-Path $env:LOCALAPPDATA "Grimcut\ffmpeg"
if ((Test-Path (Join-Path $dest "ffmpeg.exe")) -and (Test-Path (Join-Path $dest "ffprobe.exe"))) {
    Write-Host "FFmpeg already at $dest"
    exit 0
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip"
$zip = Join-Path $env:TEMP "grimcut-ffmpeg.zip"
$extract = Join-Path $env:TEMP "grimcut-ffmpeg-extract"
Write-Host "Downloading FFmpeg…"
Invoke-WebRequest -Uri $url -OutFile $zip
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force
$bin = Get-ChildItem $extract -Directory | ForEach-Object { Join-Path $_.FullName "bin" } | Where-Object { Test-Path (Join-Path $_ "ffmpeg.exe") } | Select-Object -First 1
if (-not $bin) { throw "FFmpeg zip had no bin folder." }
Get-ChildItem $bin -File | Where-Object { $_.Name -ne "ffplay.exe" -and ($_.Extension -eq ".exe" -or $_.Extension -eq ".dll") } |
    Copy-Item -Destination $dest -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $dest "ffmpeg.exe"))) { throw "ffmpeg.exe missing after install." }
Write-Host "FFmpeg installed to $dest"
