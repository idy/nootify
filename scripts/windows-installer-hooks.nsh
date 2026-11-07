; Lifecycle checked against @tauri-apps/cli 2.12.4:
; https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
; PREINSTALL is before all File commands. The updater passes /UPDATE, sets
; $UpdateMode=1, and normally skips the old uninstaller. PREUNINSTALL is before
; any Delete commands. An interactive uninstall-before-upgrade is a real
; uninstall; the next app launch installs its task again.
;
; Only the bundled CLI determines task/process ownership. Never use taskkill by
; image name, delete another installation's task, or continue after a stop error.
; Clear only this installer's process environment, before Node parses its options.
; An empty value avoids reading/truncating an inherited value and is safe if absent.
!macro NootifyClearNodeVariable NAME
  System::Call 'kernel32::SetEnvironmentVariableW(w "${NAME}", w "") i.r0'
  ${If} $0 = 0
    DetailPrint "Unable to clear ${NAME} for Nootify service management."
    Pop $0
    SetErrorLevel 1
    Abort "Unable to prepare Nootify's service environment. Installed files have not been replaced or removed."
  ${EndIf}
!macroend

!macro NootifyManageInstalledService COMMAND
  ${If} ${FileExists} "$INSTDIR\node.exe"
  ${OrIf} ${FileExists} "$INSTDIR\service\dist\src\cli.js"
    ${IfNot} ${FileExists} "$INSTDIR\node.exe"
    ${OrIfNot} ${FileExists} "$INSTDIR\service\dist\src\cli.js"
      SetErrorLevel 1
      Abort "Nootify's installed service files are incomplete. Repair the installation before continuing."
    ${EndIf}
    Push $0
    !insertmacro NootifyClearNodeVariable NODE_OPTIONS
    !insertmacro NootifyClearNodeVariable NODE_PATH
    !insertmacro NootifyClearNodeVariable NODE_EXTRA_CA_CERTS
    !insertmacro NootifyClearNodeVariable NODE_ICU_DATA
    ; The CLI allows 150 seconds for serialized service management. Give it
    ; time to report failure itself before aborting replacement/deletion.
    nsExec::ExecToLog /TIMEOUT=160000 '"$INSTDIR\node.exe" "$INSTDIR\service\dist\src\cli.js" ${COMMAND}'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Nootify ${COMMAND} failed ($0). Installed files have not been replaced or removed."
      SetErrorLevel 1
      Abort "Unable to stop Nootify's background service. Close it and retry."
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

; Tauri's .onInstSuccess handles /R after a successful /UPDATE, including /S and
; /P installs. tauri-plugin-updater supplies /R by default; the relaunched app
; starts the task. Do not start it before replacement has finished, or twice.
