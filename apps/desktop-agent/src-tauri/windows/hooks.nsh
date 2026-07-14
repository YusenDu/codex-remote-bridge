!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$SYSDIR\ie4uinit.exe" 0 icon_cache_done
  ExecWait '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
  ExecWait '"$SYSDIR\ie4uinit.exe" -show'
icon_cache_done:
!macroend
