; Domus was called NexUs (0.8–0.10) and NexusTalk (up to 0.7). Before installing,
; an old per-user installation is removed silently so there are no two apps side
; by side. Servers, accounts, chats and settings live in %APPDATA%\NexusTalk and
; are untouched; Domus keeps using that folder. If the old version was set to
; start with Windows, that setting is carried over to Domus.

!macro DOMUS_REMOVE_OLD NAME
  ; Start with Windows: move the entry over to the new program.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${NAME}"
  StrCmp $0 "" +3 0
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Domus" '"$INSTDIR\Domus.exe" --background'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${NAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${NAME}"

  IfFileExists "$LOCALAPPDATA\${NAME}\uninstall.exe" 0 +6
    DetailPrint "Entferne die alte Installation (${NAME}) …"
    ExecWait '"$LOCALAPPDATA\${NAME}\uninstall.exe" /S _?=$LOCALAPPDATA\${NAME}'
    Delete "$LOCALAPPDATA\${NAME}\uninstall.exe"
    Delete "$LOCALAPPDATA\${NAME}\nexustalk.exe"
    RMDir "$LOCALAPPDATA\${NAME}"
  Delete "$DESKTOP\${NAME}.lnk"
  Delete "$SMPROGRAMS\${NAME}.lnk"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; A running old version would block its own removal and the new start.
  nsExec::Exec 'taskkill /F /IM nexustalk.exe'
  Pop $0
  Sleep 800
  !insertmacro DOMUS_REMOVE_OLD "NexUs"
  !insertmacro DOMUS_REMOVE_OLD "NexusTalk"
!macroend
