# Installs FFmpeg into %LOCALAPPDATA%\Grimcut\ffmpeg (no admin).
# Picks the newest stable BtbN release build (ffmpeg-n<ver>-latest-win64-gpl-shared),
# so a new FFmpeg version never breaks the download. Grimcut only runs ffmpeg.exe and
# ffprobe.exe, so the DLL version doesn't matter.
# Used by the installer, embedded in the app for its in-app download, and by fetch-ffmpeg.ps1.
param(
    [string]$Dest = (Join-Path $env:LOCALAPPDATA "Grimcut\ffmpeg"),
    # Replace an existing install instead of keeping it.
    [switch]$Force
)
$ErrorActionPreference = "Stop"
# Invoke-WebRequest's progress bar slows downloads to a crawl in Windows PowerShell.
$ProgressPreference = "SilentlyContinue"

if (-not $Force -and (Test-Path (Join-Path $Dest "ffmpeg.exe")) -and (Test-Path (Join-Path $Dest "ffprobe.exe"))) {
    Write-Host "FFmpeg already at $Dest"
    exit 0
}

$base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
# Nightly build from FFmpeg master; only if GitHub's API can't be reached.
$name = "ffmpeg-master-latest-win64-gpl-shared.zip"
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest" -Headers @{ "User-Agent" = "Grimcut" }
    $newest = $release.assets |
        Where-Object { $_.name -match '^ffmpeg-n(\d+\.\d+)-latest-win64-gpl-shared-[\d.]+\.zip$' } |
        Sort-Object { [version]($_.name -replace '^ffmpeg-n(\d+\.\d+)-.*$', '$1') } -Descending |
        Select-Object -First 1
    if ($newest) { $name = $newest.name }
} catch {
    Write-Host "Couldn't list FFmpeg releases ($($_.Exception.Message)); using the nightly build."
}

$zip = Join-Path $env:TEMP "grimcut-ffmpeg.zip"
$extract = Join-Path $env:TEMP "grimcut-ffmpeg-extract"
Write-Host "Downloading $name..."
Invoke-WebRequest -Uri "$base/$name" -OutFile $zip
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force
$bin = Get-ChildItem $extract -Directory | ForEach-Object { Join-Path $_.FullName "bin" } | Where-Object { Test-Path (Join-Path $_ "ffmpeg.exe") } | Select-Object -First 1
if (-not $bin) { throw "FFmpeg zip had no bin folder." }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
# Clear old exes and DLLs so a previous version's DLLs don't linger.
Get-ChildItem $Dest -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq ".exe" -or $_.Extension -eq ".dll" } | Remove-Item -Force
Get-ChildItem $bin -File | Where-Object { $_.Name -ne "ffplay.exe" -and ($_.Extension -eq ".exe" -or $_.Extension -eq ".dll") } |
    Copy-Item -Destination $Dest -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $Dest "ffmpeg.exe"))) { throw "ffmpeg.exe missing after install." }
Write-Host "FFmpeg installed to $Dest"
