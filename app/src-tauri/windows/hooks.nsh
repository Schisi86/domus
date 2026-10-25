; NexusTalk was renamed to NexUs. Before installing, the old per-user
; installation is removed silently so there are no two apps side by side.
; Settings, servers and chats live in %APPDATA%\NexusTalk and stay untouched.

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$LOCALAPPDATA\NexusTalk\uninstall.exe" 0 nexus_no_legacy
    DetailPrint "Entferne die alte Installation (NexusTalk) …"
    ExecWait '"$LOCALAPPDATA\NexusTalk\uninstall.exe" /S _?=$LOCALAPPDATA\NexusTalk'
    Delete "$LOCALAPPDATA\NexusTalk\uninstall.exe"
    RMDir "$LOCALAPPDATA\NexusTalk"
    Delete "$DESKTOP\NexusTalk.lnk"
    Delete "$SMPROGRAMS\NexusTalk.lnk"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NexusTalk"
  nexus_no_legacy:
!macroend
