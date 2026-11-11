package storage

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/idy/nootify/internal/testutil"
)

func TestStateAndAtomicWritesUsePrivatePaths(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, name := range []string{"", "auth-token", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm"} {
		mode := os.FileMode(0600)
		if name == "" {
			mode = 0700
		}
		if err := testutil.CheckPrivatePath(filepath.Join(dir, name), mode); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	path := filepath.Join(dir, "logs", "events.ndjson")
	for _, data := range []string{"synthetic first write\n", "synthetic replacement\n"} {
		if err := WritePrivate(path, []byte(data)); err != nil {
			t.Fatal(err)
		}
		if err := testutil.CheckPrivatePath(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := testutil.CheckPrivatePath(path, 0600); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != data {
			t.Fatal("private replacement lost data", err)
		}
	}
}
