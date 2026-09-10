; Tauri CLI 2.11.4 / bundler 2.9.4 custom template.
; Supported template variables and extraction come from the pinned upstream
; installer.nsi. Intentionally NO PageReinstall/PageLeaveReinstall, old
; UninstallString execution, process-name kill, or app-data deletion.
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!define MUI_ICON "{{installer_icon}}"
!define MUI_UNICON "{{uninstaller_icon}}"
Name "Alu Dock"
OutFile "{{out_file}}"
VIProductVersion "{{version_with_build}}"
VIAddVersionKey "ProductName" "Alu Dock"
VIAddVersionKey "FileDescription" "Alu Dock Setup"
VIAddVersionKey "FileVersion" "{{version}}"
VIAddVersionKey "LegalCopyright" "{{copyright}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AluDock"
Var Gate
Var Helper
Var Payload
Var Result
Var Details
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_TEXT "Alu Dock is installed. Open it from the Start Menu. If startup needs attention, open the Host log or run Setup.exe again."
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!macro Init prefix
Function ${prefix}.onInit
  SetShellVarContext current
  SetRegView 64
  StrCpy $INSTDIR "$LOCALAPPDATA\Alu Dock\app"
  StrCpy $Gate 0
FunctionEnd
!macroend
!insertmacro Init ""
!insertmacro Init "un"

!macro GateFunctions prefix
Function ${prefix}AcquireGate
  CreateDirectory "$LOCALAPPDATA\Alu Dock"
  ; The same live, exclusive file handle is used by the native service launcher.
  System::Call 'kernel32::CreateFileW(w "$LOCALAPPDATA\Alu Dock\install.lock", i 0xC0000000, i 0, p 0, i 4, i 0x80, p 0) p .r0'
  StrCpy $Gate $0
  ${If} $Gate == -1
    StrCpy $Gate 0
    Abort "Alu Dock setup or startup is already in progress. Wait and retry."
  ${EndIf}
FunctionEnd
Function ${prefix}ReleaseGate
  ${If} $Gate != 0
    System::Call 'kernel32::CloseHandle(p $Gate)'
    StrCpy $Gate 0
  ${EndIf}
FunctionEnd
Function ${prefix}Primitive
  Pop $0
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$Helper" -Action $0 -Source "$Payload"'
  Pop $Result
  Pop $Details
  DetailPrint "$Details"
FunctionEnd
!macroend
!insertmacro GateFunctions ""
!insertmacro GateFunctions "un."
Function .onGUIEnd
  Call ReleaseGate
FunctionEnd
Function un.onGUIEnd
  Call un.ReleaseGate
FunctionEnd

Section "Install"
  InitPluginsDir
  StrCpy $Payload "$PLUGINSDIR\payload"
  StrCpy $Helper "$Payload\support\windows-package.ps1"
  SetOutPath "$PLUGINSDIR"
  ; Keep the doubled separator: one backslash escapes a Handlebars expression.
  {{#each resources_dirs}}
    CreateDirectory "$PLUGINSDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}
  WriteUninstaller "$Payload\Uninstall.exe"
  ; WebView is a prerequisite, before any legacy guard/file switch. The packaged
  ; bootstrapper is Tauri's supported embedBootstrapper input; per-user execution.
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ReadRegStr $1 HKLM "Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} "$0$1" == ""
    File "/oname=$PLUGINSDIR\WebView2Setup.exe" "{{webview2_bootstrapper_path}}"
    DetailPrint "Installing Microsoft WebView2..."
    ExecWait '"$PLUGINSDIR\WebView2Setup.exe" /silent /install' $Result
    ${If} $Result != 0
      Abort "WebView2 installation did not finish. Install Microsoft WebView2 and rerun Setup.exe."
    ${EndIf}
  ${EndIf}
  Call AcquireGate
  DetailPrint "Checking the package and closing Alu Dock safely..."
  Push Prepare
  Call Primitive
  ${If} $Result != 0
    Call ReleaseGate
    Abort "$Details"
  ${EndIf}
  Push Commit
  Call Primitive
  ${If} $Result != 0
    Call ReleaseGate
    Abort "$Details"
  ${EndIf}
  ; Everything below is postcommit: integration/startup/cleanup errors leave
  ; the complete new package installed, so rerunning Setup is repair.
  ClearErrors
  CreateShortcut "$SMPROGRAMS\Alu Dock.lnk" "$INSTDIR\AluDock.exe" "" "$INSTDIR\AluDock.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "Alu Dock"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "{{version}}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\AluDock.exe,0"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${If} ${Errors}
    DetailPrint "Alu Dock is installed. Rerun Setup.exe to finish Windows app registration and shortcuts."
  ${EndIf}
  Push PathInstall
  Call Primitive
  ${If} $Result != 0
    DetailPrint "Alu Dock is installed. Rerun Setup.exe to finish the command entry."
  ${EndIf}
  Push Cleanup
  Call Primitive
  ${If} $Result != 0
    DetailPrint "Alu Dock is installed. Rerun Setup.exe to finish removing the previous package."
  ${EndIf}
  Call ReleaseGate
  DetailPrint "Alu Dock is installed. Starting in the background..."
  ; Desktop starts asynchronously and observes the same Host. Installation is
  ; complete regardless of readiness, launch failure or slow Pi initialization.
  Exec '"$INSTDIR\AluDock.exe"'
SectionEnd

Section "Uninstall"
  InitPluginsDir
  StrCpy $Payload ""
  StrCpy $Helper "$PLUGINSDIR\windows-package.ps1"
  CopyFiles /SILENT "$INSTDIR\support\windows-package.ps1" "$Helper"
  Call un.AcquireGate
  Push Remove
  Call un.Primitive
  ${If} $Result != 0
    Call un.ReleaseGate
    Abort "$Details"
  ${EndIf}
  Delete "$SMPROGRAMS\Alu Dock.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  Push PathRemove
  Call un.Primitive
  ${If} $Result != 0
    DetailPrint "$Details"
  ${EndIf}
  Call un.ReleaseGate
  ; Sibling state/logs/attachments, Pi and bundle-ID client data are untouched.
SectionEnd
