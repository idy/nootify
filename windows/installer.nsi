; Nootify's per-user installer. Keep the registration name and installed layout
; compatible with existing Nootify clients and /S or /P /UPDATE /R invocations.
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
Var PassiveMode
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nootify"

Page directory NootifyDirectoryPre
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

!macro InitOptions
  SetShellVarContext current
  SetRegView 64
  StrCpy $UpdateMode 0
  StrCpy $Relaunch 0
  StrCpy $PassiveMode 0
  ${GetParameters} $0
  ; Tauri's legacy passive updater uses /P /UPDATE /R. /P is not an NSIS
  ; built-in: retain the progress page, but require no directory/finish clicks.
  ClearErrors
  ${GetOptions} $0 "/P" $1
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
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
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Nootify requires 64-bit Windows."
    SetErrorLevel 1
    Quit
  ${EndIf}
  Call NootifyAcknowledgeUpdater
FunctionEnd

Function un.onInit
  !insertmacro InitOptions
FunctionEnd

Function NootifyDirectoryPre
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
FunctionEnd

; This acknowledges only the updater's exact private cache layout and receipt.
; No image is deleted here: the next desktop start retries unlocked images and
; removes their directories nonrecursively. A pending ShellExecute is never swept.
Function NootifyAcknowledgeUpdater
  ${If} $UpdateMode != 1
    Return
  ${EndIf}
  ${If} $EXEFILE != "Nootify-setup.exe"
    Return
  ${EndIf}
  ${GetParent} "$EXEDIR" $0
  ${If} $0 != "$LOCALAPPDATA\dev.idy.nootify\updates"
    Return
  ${EndIf}
  ${GetFileName} "$EXEDIR" $0
  StrCpy $0 $0 10
  ${If} $0 != "installer-"
    Return
  ${EndIf}
  ; Refuse directories/reparse points in the receipt location.
  System::Call 'kernel32::GetFileAttributesW(w "$EXEDIR\handoff") i.r0'
  IntOp $0 $0 & 0x410
  ${If} $0 != 0
    Return
  ${EndIf}
  ClearErrors
  FileOpen $0 "$EXEDIR\handoff" r
  ${If} ${Errors}
    Return
  ${EndIf}
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "nootify-installer-pending-v1$\n"
    Return
  ${EndIf}
  ClearErrors
  FileOpen $0 "$EXEDIR\handoff" w
  ${IfNot} ${Errors}
    FileWrite $0 "nootify-installer-opened-v1$\n"
    FileClose $0
  ${EndIf}
FunctionEnd

; Recursive payload replacement is permitted only in a registered installation.
; A fresh target containing an unrelated service/ (even an empty one) is refused
; before hooks run, and its files remain untouched.
Function NootifyPreflightPayload
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      SetErrorLevel 1
      Abort "The installation target is a reparse point. Choose an empty directory."
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\service") i.r0 ?e'
  Pop $1
  ${If} $0 = -1
  ${AndIf} $1 != 2
  ${AndIf} $1 != 3
    SetErrorLevel 1
    Abort "Cannot inspect the target service directory. Its files have not been changed."
  ${EndIf}
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      SetErrorLevel 1
      Abort "The target service directory is a reparse point. Choose an empty directory."
    ${EndIf}
  ${EndIf}
  ${If} $0 != -1
  ${OrIf} ${FileExists} "$INSTDIR\Nootify.exe"
  ${OrIf} ${FileExists} "$INSTDIR\node.exe"
  ${OrIf} ${FileExists} "$INSTDIR\nootify-core.exe"
  ${OrIf} ${FileExists} "$INSTDIR\nootify-tsnet.exe"
    ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
    ${If} $0 != $INSTDIR
      SetErrorLevel 1
      Abort "The target contains files not owned by this registered Nootify installation. Choose an empty directory."
    ${EndIf}
    ${IfNot} ${FileExists} "$INSTDIR\Nootify.exe"
    ${OrIfNot} ${FileExists} "$INSTDIR\node.exe"
    ${OrIfNot} ${FileExists} "$INSTDIR\service\dist\src\cli.js"
      SetErrorLevel 1
      Abort "Nootify's installed files are incomplete. Repair the installation before continuing."
    ${EndIf}
  ${EndIf}
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
  Call NootifyPreflightPayload
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
  ; /R works with /S, /P and /UPDATE too. Only the fully replaced desktop starts
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
