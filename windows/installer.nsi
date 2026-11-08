; Nootify's per-user installer. Keep the registration name and installed layout
; compatible with existing Nootify clients and their /S /UPDATE /R invocation.
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
Name "Nootify"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Nootify"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nootify" "InstallLocation"
BrandingText "Nootify"
Icon "${ICON}"
UninstallIcon "${ICON}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Nootify"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "Nootify installer"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright Nootify contributors"

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "${HOOKS}"

Var UpdateMode
Var Relaunch
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nootify"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

!macro InitOptions
  SetShellVarContext current
  SetRegView 64
  StrCpy $UpdateMode 0
  StrCpy $Relaunch 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/R" $1
  ${IfNot} ${Errors}
    StrCpy $Relaunch 1
  ${EndIf}
!macroend

Function .onInit
  !insertmacro InitOptions
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Nootify requires 64-bit Windows."
    SetErrorLevel 1
    Quit
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro InitOptions
FunctionEnd

!macro NootifyPreflightDesktop OPERATION
  Push $0
  Push $1
  ; OPEN_EXISTING + GENERIC_WRITE checks replaceability without creating,
  ; truncating or changing the existing executable. Share all other accesses.
  ; A mapped desktop image (or another write-denying handle) fails this check.
  StrCpy $1 0
  ${If} $UpdateMode = 1
    ; The updater starts this installer before its own process has exited.
    ; Allow at most 20 seconds for that handoff; never kill a process by name.
    StrCpy $1 80
  ${EndIf}
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\Nootify.exe"
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\Nootify.exe", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p.r0'
    ${If} $0 != -1
      System::Call 'kernel32::CloseHandle(p r0)'
      ${ExitDo}
    ${EndIf}
    ${If} $1 = 0
      Pop $1
      Pop $0
      SetErrorLevel 1
      MessageBox MB_OK|MB_ICONSTOP "Close Nootify and retry the ${OPERATION}. Its executable is still in use or cannot be replaced. The existing files and service have not been changed." /SD IDOK
      Abort "Nootify.exe is not writable; existing files and service are unchanged."
    ${EndIf}
    Sleep 250
    IntOp $1 $1 - 1
  ${Loop}
  Pop $1
  Pop $0
!macroend

Function NootifyPreflightDesktop
  !insertmacro NootifyPreflightDesktop "installation"
FunctionEnd

Function un.NootifyPreflightDesktop
  !insertmacro NootifyPreflightDesktop "uninstallation"
FunctionEnd

Section "Nootify" Install
  ; Check the desktop lock before stopping its independent service or deleting
  ; resources. Failed upgrades must leave the previous installation operational.
  Call NootifyPreflightDesktop
  ; The checked, environment-sanitized bundled CLI owns task/process validation.
  ; Abort on failure before deleting/replacing any payload. Do not invoke the
  ; old uninstaller during updates: the registered task must retain its identity.
  !insertmacro NSIS_HOOK_PREINSTALL
  SetOutPath "$INSTDIR"
  SetOverwrite on
  RMDir /r "$INSTDIR\service"
  File "${PAYLOAD}\Nootify.exe"
  File "${PAYLOAD}\node.exe"
  File "${PAYLOAD}\nootify-core.exe"
  File "${PAYLOAD}\nootify-tsnet.exe"
  File /r "${PAYLOAD}\service"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Nootify.lnk" "$INSTDIR\Nootify.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Nootify"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "IDY"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '$\"$INSTDIR\Nootify.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "AppUserModelId" "dev.idy.nootify"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function .onInstSuccess
  ; /R works with /S and /UPDATE too. Only the fully replaced desktop starts
  ; the task, once, after all files and registration have been written.
  ${If} $Relaunch = 1
    Exec '$\"$INSTDIR\Nootify.exe$\"'
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; The desktop is independent of the owned service job. Refuse a locked image
  ; before stopping that service or removing payload, task or registration.
  Call un.NootifyPreflightDesktop
  !insertmacro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\Nootify.exe"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\nootify-core.exe"
  Delete "$INSTDIR\nootify-tsnet.exe"
  RMDir /r "$INSTDIR\service"
  Delete "$INSTDIR\uninstall.exe"
  ; Another installation may own the stable registration; leave it untouched.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    Delete "$SMPROGRAMS\Nootify.lnk"
  ${EndIf}
  ; Nonrecursive: retain private data and any files not owned by this package.
  RMDir "$INSTDIR"
SectionEnd
