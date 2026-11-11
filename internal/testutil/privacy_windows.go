package testutil

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CheckPrivatePath checks actual Windows access rules rather than os.FileMode,
// whose Unix privacy bits are not represented by Windows Stat/Chmod. Inherited
// grants are permitted only when they also name the current user or SYSTEM.
func CheckPrivatePath(path string, _ os.FileMode) error {
	if _, err := os.Stat(path); err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	current := user.User.Sid.String()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	if owner == nil || owner.String() != current {
		return fmt.Errorf("private path %s: owner is not the current user", path)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if dacl == nil {
		return fmt.Errorf("private path %s: missing DACL grants unrestricted access", path)
	}
	seen := map[string]bool{}
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var pointer *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &pointer); err != nil {
			return err
		}
		if pointer.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return fmt.Errorf("private path %s: unrecognized ACE type %d", path, pointer.Header.AceType)
		}
		sid := (*windows.SID)(unsafe.Pointer(&pointer.SidStart)).String()
		if sid != current && sid != "S-1-5-18" {
			return fmt.Errorf("private path %s: access granted to unrelated SID %s", path, sid)
		}
		if pointer.Header.AceFlags&windows.INHERIT_ONLY_ACE == 0 && pointer.Mask != 0 {
			seen[sid] = true
		}
	}
	if !seen[current] || !seen["S-1-5-18"] {
		return fmt.Errorf("private path %s: missing current-user or SYSTEM access", path)
	}
	return nil
}
