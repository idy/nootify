; The production installer stages and verifies its payload through the transaction
; helper, which invokes the same owned bundled CLI after recording running state.
; PREINSTALL remains for compatibility/hook probes; PREUNINSTALL precedes Delete.
; /UPDATE sets $UpdateMode=1 and preserves this installation's task and state.
; Real uninstall removes only the task owned by this exact bundled CLI.
;
; Only the bundled CLI determines task/process ownership. Never use taskkill by
; image name, delete another installation's task, or continue after a stop error.
; Opt-in native CI diagnostics; never log environment values.
!ifndef NOOTIFY_INSTALLER_HOOK_DIAGNOSTICS
!if "$%NOOTIFY_INSTALLER_HOOK_DIAGNOSTICS%" == "1"
  !define NOOTIFY_INSTALLER_HOOK_DIAGNOSTICS
!endif
!endif
!ifdef NOOTIFY_INSTALLER_HOOK_DIAGNOSTICS
!ifndef NOOTIFY_INSTALLER_HOOK_LOG
!if "$%NOOTIFY_INSTALLER_HOOK_LOG%" != ""
  !define NOOTIFY_INSTALLER_HOOK_LOG "$%NOOTIFY_INSTALLER_HOOK_LOG%"
!else
  !define NOOTIFY_INSTALLER_HOOK_LOG "$EXEDIR\nootify-installer-hook.log"
!endif
!endif
!endif
!macro NootifyInstallerTrace TEXT
!ifdef NOOTIFY_INSTALLER_HOOK_DIAGNOSTICS
  Push $R9
  FileOpen $R9 "${NOOTIFY_INSTALLER_HOOK_LOG}" a
  FileSeek $R9 0 END
  FileWrite $R9 "${TEXT}$\r$\n"
  FileClose $R9
  Pop $R9
!endif
!macroend

!macro NootifyManageInstalledService COMMAND
  ${If} ${FileExists} "$INSTDIR\Nootify.exe"
    Push $0
    Push $R8
    StrCpy $R8 "$OUTDIR"
    ClearErrors
    SetOutPath "$SYSDIR"
    ${If} ${Errors}
      SetOutPath "$R8"
      Pop $R8
      Pop $0
      SetErrorLevel 1
      Abort "Unable to select a safe service command directory. Installed files are unchanged."
    ${EndIf}
    ; Current Go controls inspect legacy registrations without executing old
    ; installed Node/GUI binaries. The helper remains outside exchanged payload.
    nsExec::ExecToLog /TIMEOUT=900000 '"$PLUGINSDIR\nootify-installer-stage.exe" --action ${COMMAND} --target "$INSTDIR"'
    Pop $0
    SetOutPath "$R8"
    Pop $R8
    !insertmacro NootifyInstallerTrace "manage ${COMMAND}: result=$0"
    ${If} $0 != 0
      SetErrorLevel 1
      Abort "Unable to stop Nootify's background service. Installed files were retained."
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NootifyManageInstalledService service-stop
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode = 1
    !insertmacro NootifyManageInstalledService service-stop
  ${Else}
    !insertmacro NootifyManageInstalledService service-uninstall
  ${EndIf}
!macroend

; The transaction helper restores a previously running service independently of
; /R. .onInstSuccess handles optional desktop launch only, including /S /UPDATE.
; A deliberately stopped service is not started by the transaction helper.
