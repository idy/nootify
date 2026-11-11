package testutil

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestPrivatePathChecksWindowsDACL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "synthetic-private-file")
	if err := os.WriteFile(path, []byte("synthetic fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	current := user.User.Sid
	private := "D:P(A;;FA;;;" + current.String() + ")(A;;FA;;;SY)"
	for _, broad := range []bool{true, false} {
		sddl := private
		if broad {
			sddl += "(A;;FR;;;WD)"
		}
		sd, err := windows.SecurityDescriptorFromString(sddl)
		if err != nil {
			t.Fatal(err)
		}
		dacl, _, err := sd.DACL()
		if err != nil {
			t.Fatal(err)
		}
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, current, nil, dacl, nil); err != nil {
			t.Fatal(err)
		}
		err = CheckPrivatePath(path, 0600)
		if (err != nil) != broad {
			t.Fatalf("broad=%v: DACL check returned %v", broad, err)
		}
	}
}
