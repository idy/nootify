package privatepath

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/idy/nootify/internal/testutil"
	"golang.org/x/sys/windows"
)

func TestProtectWindowsInheritanceAndPermissiveChildRepair(t *testing.T) {
	dir := t.TempDir()
	if err := Protect(dir, true); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "inherited.json")
	if err := os.WriteFile(path, []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	// Verify a fresh child is private even before any explicit file repair.
	if err := testutil.CheckPrivatePath(path, 0600); err != nil {
		t.Fatal("directory ACL did not inherit:", err)
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
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	if err := testutil.CheckPrivatePath(path, 0600); err == nil {
		t.Fatal("fixture is not permissive")
	}
	if err := Protect(path, false); err != nil {
		t.Fatal(err)
	}
	if err := testutil.CheckPrivatePath(path, 0600); err != nil {
		t.Fatal("protected permissive file was not repaired:", err)
	}
}
