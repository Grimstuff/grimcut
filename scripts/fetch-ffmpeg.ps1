# Dev setup: puts the newest stable FFmpeg build in tools\ffmpeg, which a dev
# checkout of Grimcut finds. Same download as the installer and the in-app prompt.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot "install-ffmpeg.ps1") -Dest (Join-Path $root "tools\ffmpeg") -Force
