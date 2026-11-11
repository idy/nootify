package privatepath

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/idy/nootify/internal/testutil"
)

func TestProtectDirectoryAndOpenFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0777); err != nil {
		t.Fatal(err)
	}
	if err := Protect(dir, true); err != nil {
		t.Fatal(err)
	}
	if err := testutil.CheckPrivatePath(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.CreateTemp(dir, "private")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := Protect(file.Name(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("synthetic")); err != nil {
		t.Fatal(err)
	}
	if err := testutil.CheckPrivatePath(file.Name(), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestProtectRefusesRedirectedOrLinkedFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if err := os.WriteFile(path, []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "hardlink")
	if err := os.Link(path, link); err != nil {
		t.Skip("hard links unavailable:", err)
	}
	if err := Protect(path, false); err == nil {
		t.Fatal("accepted a multiply-linked file")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := Protect(path, true); err == nil {
		t.Fatal("accepted a file as a directory")
	}
	symlink := filepath.Join(dir, "redirect")
	if err := os.Symlink(path, symlink); err != nil {
		t.Log("symlink creation unavailable:", err)
		return
	}
	if err := Protect(symlink, false); err == nil {
		t.Fatal("accepted a redirected file")
	}
}
