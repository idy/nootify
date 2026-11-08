package main

import (
	"path/filepath"
	"strings"
	"testing"

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
		sddl := descriptor.String()
		if !strings.Contains(sddl, user.User.Sid.String()) || strings.Contains(sddl, ";;;WD)") || strings.Contains(sddl, ";;;BU)") {
			t.Fatal("state is accessible beyond current user and SYSTEM")
		}
	}
	if second, err := OpenStore(dir); err == nil {
		second.Close()
		t.Fatal("Windows process lock did not exclude a second writer")
	}
}
