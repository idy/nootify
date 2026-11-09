; A receipt authorizes prepare only after BOTH values were written. Interrupted
; publication may leave either value alone, which must not lock another target.
; Never inspect the target filesystem here: the old drive may be unavailable.
!macro NootifyReadPendingReceipt KEY
  Push $0
  Push $1
  Push $2
  ReadRegStr $PendingLocation HKCU "${KEY}" "Target"
  ReadRegStr $FreshToken HKCU "${KEY}" "Token"
  ${If} $PendingLocation == ""
  ${OrIf} $FreshToken == ""
    ; ReadRegStr also reports errors as empty. Confirm missing/REG_SZ values
    ; before clearing; denied reads and other malformed types retain authority.
    ; RRF_NOEXPAND | RRF_SUBKEY_WOW6464KEY | RRF_RT_REG_SZ matches SetRegView 64.
    System::Call 'advapi32::RegGetValueW(p 0x80000001, w "${KEY}", w "Target", i 0x10010002, p 0, p 0, *i .r2) i.r0'
    System::Call 'advapi32::RegGetValueW(p 0x80000001, w "${KEY}", w "Token", i 0x10010002, p 0, p 0, *i .r2) i.r1'
    ${If} $0 != 0
    ${AndIf} $0 != 2
      SetErrorLevel 1
      Abort "Cannot inspect Nootify's pending installation receipt. It has been retained."
    ${EndIf}
    ${If} $1 != 0
    ${AndIf} $1 != 2
      SetErrorLevel 1
      Abort "Cannot inspect Nootify's pending installation receipt. It has been retained."
    ${EndIf}
    DeleteRegKey HKCU "${KEY}"
    StrCpy $PendingLocation ""
    StrCpy $FreshToken ""
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NootifyCheckPendingDestination
  ${If} $PendingLocation != ""
  ${AndIf} $PendingLocation != $INSTDIR
    SetErrorLevel 1
    Abort "A Nootify installation is pending in another directory. Retry it there before choosing a new destination."
  ${EndIf}
!macroend
