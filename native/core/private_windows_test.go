package main

import (
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsStateUsesProtectedUserACLAndStableLock(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	must(t, err)
	defer s.Close()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	must(t, err)
	for _, path := range []string{dir, filepath.Join(dir, "core.lock"), filepath.Join(dir, "state.json")} {
		descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		must(t, err)
		control, _, err := descriptor.Control()
		must(t, err)
		if control&windows.SE_DACL_PROTECTED == 0 {
			t.Fatalf("state ACL is not protected: %s", path)
		}
		// SDDL may abbreviate a well-known account SID (for example LA on
		// elevated CI runners). Inspect ACEs rather than the display spelling.
		dacl, _, err := descriptor.DACL()
		must(t, err)
		if dacl == nil || dacl.AceCount != 2 {
			t.Fatalf("expected exactly user and SYSTEM access: %s", path)
		}
		seenUser, seenSystem := false, false
		for i := uint32(0); i < uint32(dacl.AceCount); i++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			must(t, windows.GetAce(dacl, i, &ace))
			if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
				t.Fatalf("unexpected state access entry: %s", path)
			}
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			switch {
			case sid.Equals(user.User.Sid):
				seenUser = true
			case sid.IsWellKnown(windows.WinLocalSystemSid):
				seenSystem = true
			default:
				t.Fatalf("state grants access to an unrelated SID: %s", sid.String())
			}
			required := windows.ACCESS_MASK(windows.FILE_GENERIC_READ | windows.FILE_GENERIC_WRITE | windows.DELETE)
			if ace.Mask&required != required {
				t.Fatalf("user/SYSTEM state access is incomplete: %s", path)
			}
		}
		if !seenUser || !seenSystem {
			t.Fatalf("state must grant access to both user and SYSTEM: %s", path)
		}
	}
	if second, err := OpenStore(dir); err == nil {
		second.Close()
		t.Fatal("Windows process lock did not exclude a second writer")
	}
}
