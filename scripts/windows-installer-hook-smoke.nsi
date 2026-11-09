; Headless native probe: dummy hooks or isolated temporary registry receipts.
; No installed app files, private state, real tasks or services are used.
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
AutoCloseWindow true
Name "Nootify installer hook probe"
OutFile "${PROBE_OUTPUT}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!ifndef PROBE_NO_DIAGNOSTICS
  !define NOOTIFY_INSTALLER_HOOK_DIAGNOSTICS
  !define NOOTIFY_INSTALLER_HOOK_LOG "$EXEDIR\nootify-installer-hook.log"
!endif
!include "windows-installer-hooks.nsh"
!include "${__FILEDIR__}/../windows/pending-receipt.nsh"
!ifndef PROBE_RECEIPT_KEY
  !define PROBE_RECEIPT_KEY "Software\Nootify\InstallerReceiptProbe"
!endif
Var UpdateMode
Var PendingLocation
Var FreshToken

!macro ProbeInit UNINSTALL
  StrCpy $UpdateMode 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  !if ${UNINSTALL} = 1
    ; _?= keeps the original uninstaller synchronous in this exact payload.
    StrCpy $INSTDIR "$EXEDIR"
  !else
    StrCpy $INSTDIR "$EXEDIR\payload"
  !endif
!macroend

Function .onInit
  !insertmacro ProbeInit 0
  ClearErrors
  ${GetOptions} $0 "/RECEIPT=" $3
  ${IfNot} ${Errors}
    SetRegView 64
    !insertmacro NootifyReadPendingReceipt "${PROBE_RECEIPT_KEY}"
    ${If} $3 == "clear"
      ${If} $PendingLocation != ""
      ${OrIf} $FreshToken != ""
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${Else}
      ${If} $PendingLocation == ""
      ${OrIf} $FreshToken == ""
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
    ${If} $3 == "matching"
      StrCpy $INSTDIR $PendingLocation
    ${EndIf}
    !insertmacro NootifyCheckPendingDestination
    ${If} $3 != "clear"
    ${AndIf} $3 != "matching"
      SetErrorLevel 2
      Quit
    ${EndIf}
    SetErrorLevel 0
    Quit
  ${EndIf}
FunctionEnd
Function un.onInit
  !insertmacro ProbeInit 1
FunctionEnd

!macro ProbeHook HOOK
  FileOpen $3 "$EXEDIR\probe-state.log" a
  FileWrite $3 "begin ${HOOK} mode=$UpdateMode$\r$\n"
  FileClose $3
  Push "hook-stack-bottom"
  Push "hook-stack-top"
  StrCpy $0 "hook-register-zero"
  StrCpy $1 "hook-register-one"
  !insertmacro ${HOOK}
  ${If} $0 != "hook-register-zero"
  ${OrIf} $1 != "hook-register-one"
    FileOpen $3 "$EXEDIR\probe-state.log" a
    FileWrite $3 "FAIL register preservation$\r$\n"
    FileClose $3
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $2
  ${If} $2 != "hook-stack-top"
    FileOpen $3 "$EXEDIR\probe-state.log" a
    FileWrite $3 "FAIL stack top$\r$\n"
    FileClose $3
    SetErrorLevel 3
    Quit
  ${EndIf}
  Pop $2
  ${If} $2 != "hook-stack-bottom"
    FileOpen $3 "$EXEDIR\probe-state.log" a
    FileWrite $3 "FAIL stack bottom$\r$\n"
    FileClose $3
    SetErrorLevel 4
    Quit
  ${EndIf}
  FileOpen $3 "$EXEDIR\probe-state.log" a
  FileWrite $3 "PASS ${HOOK} mode=$UpdateMode registers stack$\r$\n"
  FileClose $3
!macroend

Section "Install"
  !insertmacro ProbeHook NSIS_HOOK_PREINSTALL
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd
Section "Uninstall"
  !insertmacro ProbeHook NSIS_HOOK_PREUNINSTALL
  ; Retain the dummy payload for assertions; never invoke real removal APIs.
SectionEnd
