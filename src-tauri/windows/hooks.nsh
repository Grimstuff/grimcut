!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$LOCALAPPDATA\Grimcut\ffmpeg\ffmpeg.exe" ffmpeg_ok
  nsExec::ExecToStack 'where ffmpeg'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" ffmpeg_ok 0
  MessageBox MB_YESNO|MB_ICONINFORMATION "Grimcut needs FFmpeg to open and export video (like DirectX for games).$\r$\n$\r$\nDownload and install FFmpeg now? (~80 MB)$\r$\nIf you skip this, Grimcut will ask again the first time you open it." IDYES ffmpeg_dl IDNO ffmpeg_ok
  ffmpeg_dl:
    DetailPrint "Installing FFmpeg…"
    IfFileExists "$INSTDIR\install-ffmpeg.ps1" 0 ffmpeg_alt
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-ffmpeg.ps1"'
    Goto ffmpeg_ok
  ffmpeg_alt:
    IfFileExists "$INSTDIR\resources\install-ffmpeg.ps1" 0 ffmpeg_ok
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-ffmpeg.ps1"'
  ffmpeg_ok:
!macroend
