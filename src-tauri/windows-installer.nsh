!macro NSIS_HOOK_PREINSTALL
  ; The Tauri updater can launch this installer while the desktop process is
  ; still running. Stop it before NSIS replaces its executable.
  ExecWait '"$SYSDIR\\taskkill.exe" /IM "${MAINBINARYNAME}.exe"'
  Sleep 1500
  ExecWait '"$SYSDIR\\taskkill.exe" /F /IM "${MAINBINARYNAME}.exe"'
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Recreate shortcuts during upgrades so Windows refreshes the embedded app icon.
  ${If} $UpdateMode = 1
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend
