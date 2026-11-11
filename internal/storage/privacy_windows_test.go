package storage

import (
	"path/filepath"
	"testing"

	"github.com/idy/nootify/internal/testutil"
	"golang.org/x/sys/windows"
)

func TestStartupRepairsExplicitPermissiveWindowsState(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	token := s.Token
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FA;;;SY)(A;;FR;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"auth-token", "state.sqlite"} {
		path := filepath.Join(dir, name)
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
			t.Fatal(err)
		}
		if err := testutil.CheckPrivatePath(path, 0600); err == nil {
			t.Fatal("permissive fixture was not applied")
		}
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Token != token {
		t.Fatal("permission repair replaced authentication identity")
	}
	for _, name := range []string{"auth-token", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm"} {
		if err := testutil.CheckPrivatePath(filepath.Join(dir, name), 0600); err != nil {
			t.Fatal("active state retained broad permissions:", err)
		}
	}
}
