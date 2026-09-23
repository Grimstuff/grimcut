@echo off
cd /d "%~dp0.."
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" /min pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0relaunch.ps1"
) else (
  start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0relaunch.ps1"
)
