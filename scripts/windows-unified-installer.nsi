; Builds a lightweight Windows bootstrapper. The bootstrapper selects the
; native installer for the current machine and delegates installation to it.
; Define PAYLOAD_DIR, OUTFILE, and APP_VERSION when invoking makensis.

Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow

!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR is required"
!endif

!ifndef OUTFILE
  !error "OUTFILE is required"
!endif

!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif

!include "LogicLib.nsh"

Name "AUTO Gateway Desktop ${APP_VERSION}"
Caption "Installing AUTO Gateway Desktop"
OutFile "${OUTFILE}"
BrandingText "AUTO Gateway Desktop"

Var NativeArchitecture
Var PayloadDirectory
Var InstallerExitCode

Function .onInit
  ; This system key contains the host architecture, unlike the process
  ; environment which can report x64 while running under Windows on Arm.
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "PROCESSOR_ARCHITECTURE"
  StrCmp $0 "ARM64" select_arm64 select_x64

select_arm64:
  StrCpy $NativeArchitecture "arm64"
  Goto architecture_selected

select_x64:
  StrCpy $NativeArchitecture "x64"

architecture_selected:
  StrCpy $PayloadDirectory "$TEMP\\AUTO-Gateway-Desktop-${APP_VERSION}"
  CreateDirectory "$PayloadDirectory"
FunctionEnd

Section "Install AUTO Gateway Desktop"
  SetOutPath "$PayloadDirectory"
  StrCmp $NativeArchitecture "arm64" install_arm64 install_x64

install_arm64:
  File /oname=AUTO-Gateway-Desktop-arm64-setup.exe "${PAYLOAD_DIR}\\AUTO-Gateway-Desktop-arm64-setup.exe"
  ExecWait '"$PayloadDirectory\\AUTO-Gateway-Desktop-arm64-setup.exe"' $InstallerExitCode
  Goto installer_finished

install_x64:
  File /oname=AUTO-Gateway-Desktop-x64-setup.exe "${PAYLOAD_DIR}\\AUTO-Gateway-Desktop-x64-setup.exe"
  ExecWait '"$PayloadDirectory\\AUTO-Gateway-Desktop-x64-setup.exe"' $InstallerExitCode

installer_finished:
  RMDir /r "$PayloadDirectory"
  ${If} $InstallerExitCode != 0
    MessageBox MB_ICONSTOP "AUTO Gateway Desktop could not be installed. The native installer returned error $InstallerExitCode."
    Abort
  ${EndIf}
SectionEnd
