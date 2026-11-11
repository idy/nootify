package tailscale

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func assertPrivateWindowsDACL(t *testing.T, path string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("state DACL is not protected: %v, %v", control, err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 2 {
		t.Fatalf("expected only the user and SYSTEM in state DACL: %v", err)
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var pointer *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &pointer); err != nil {
			t.Fatal(err)
		}
		if pointer.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			t.Fatal("unexpected state ACE type")
		}
		sid := (*windows.SID)(unsafe.Pointer(&pointer.SidStart))
		if !sid.Equals(user.User.Sid) && !sid.IsWellKnown(windows.WinLocalSystemSid) {
			t.Fatalf("state grants access to an unrelated SID: %v", sid)
		}
		required := windows.ACCESS_MASK(windows.FILE_GENERIC_READ | windows.FILE_GENERIC_WRITE | windows.DELETE)
		if pointer.Mask&required != required {
			t.Fatal("user/SYSTEM must retain state access")
		}
	}
}

func TestWindowsStateDACLProtectsNewAndExistingFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state")
	lock, err := prepareStateDir(path)
	if err != nil {
		t.Fatal(err)
	}
	lock.Close()
	state := filepath.Join(path, "tailscaled.state")
	if err := os.WriteFile(state, []byte("test-state"), 0600); err != nil {
		t.Fatal(err)
	}
	// A previous installation might have inherited broad permissions. Repair
	// both existing data and the inheritable directory DACL before tsnet starts.
	broad, err := windows.SecurityDescriptorFromString("D:(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{path, state} {
		if err := windows.SetNamedSecurityInfo(name, windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
			t.Fatal(err)
		}
	}
	lock, err = prepareStateDir(path)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	for _, name := range []string{path, state, filepath.Join(path, stateLockName)} {
		assertPrivateWindowsDACL(t, name)
	}
}

func TestWindowsStateRejectsLinksWithoutChangingTargets(t *testing.T) {
	for _, kind := range []string{"root-symlink", "directory-symlink", "file-symlink", "hardlink", "lock-hardlink"} {
		t.Run(kind, func(t *testing.T) {
			base := t.TempDir()
			outside := filepath.Join(base, "outside")
			if err := os.Mkdir(outside, 0700); err != nil {
				t.Fatal(err)
			}
			original := filepath.Join(outside, "original")
			if err := os.WriteFile(original, []byte("unchanged"), 0600); err != nil {
				t.Fatal(err)
			}
			before, err := windows.GetNamedSecurityInfo(original, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
			if err != nil {
				t.Fatal(err)
			}
			state := filepath.Join(base, "state")
			if kind == "root-symlink" {
				if err := os.Symlink(outside, state); err != nil {
					t.Skipf("creating symlinks requires Developer Mode or symlink privilege: %v", err)
				}
			} else {
				if err := os.Mkdir(state, 0700); err != nil {
					t.Fatal(err)
				}
				name := filepath.Join(state, "tailscaled.state")
				if kind == "lock-hardlink" {
					name = filepath.Join(state, stateLockName)
				}
				if strings.HasSuffix(kind, "hardlink") {
					err = os.Link(original, name)
				} else if kind == "directory-symlink" {
					err = os.Symlink(outside, name)
				} else {
					err = os.Symlink(original, name)
				}
				if err != nil {
					if strings.HasSuffix(kind, "symlink") {
						t.Skipf("creating symlinks requires Developer Mode or symlink privilege: %v", err)
					}
					t.Fatal(err)
				}
			}
			if lock, err := prepareStateDir(state); err == nil {
				lock.Close()
				t.Fatal("accepted linked state")
			}
			after, err := windows.GetNamedSecurityInfo(original, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
			if err != nil || before.String() != after.String() {
				t.Fatalf("changed linked target DACL: %v", err)
			}
			data, err := os.ReadFile(original)
			if err != nil || string(data) != "unchanged" {
				t.Fatalf("changed linked target data: %v", err)
			}
		})
	}
}

func TestWindowsStateRejectsVolumeRoots(t *testing.T) {
	for _, root := range []string{filepath.VolumeName(t.TempDir()) + `\`, `\\server\share\`} {
		if validStateDir(root) {
			t.Fatalf("accepted volume root %q", root)
		}
	}
}
