package updater

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDeferredInstallerCleanupOnlyRemovesOpenedUnlockedOwnedFiles(t *testing.T) {
	cache := t.TempDir()
	for _, scenario := range []string{"opened", "pending", "locked", "unowned", "extra file", "symlink"} {
		dir := filepath.Join(cache, "installer-"+scenario)
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		receipt := installerOpened
		if scenario == "pending" {
			receipt = installerPending
		}
		if scenario == "unowned" {
			receipt = "unrelated file\n"
		}
		if err := os.WriteFile(filepath.Join(dir, installerReceipt), []byte(receipt), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, installerName), []byte("synthetic image, never executed"), 0600); err != nil {
			t.Fatal(err)
		}
		if scenario == "extra file" {
			if err := os.WriteFile(filepath.Join(dir, "user-data"), []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	outside := t.TempDir()
	outsideImage := filepath.Join(outside, installerName)
	if err := os.WriteFile(outsideImage, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		linked := filepath.Join(cache, "installer-symlink", installerName)
		if err := os.Remove(linked); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsideImage, linked); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(cache, "installer-directory-link")); err != nil {
			t.Fatal(err)
		}
	}
	remove := func(root *os.Root, image string) error {
		if filepath.Dir(image) == "installer-locked" {
			return errors.New("synthetic Windows sharing violation")
		}
		return root.Remove(image)
	}
	if err := cleanupInstallers(cache, remove); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cache, "installer-opened")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("opened installer retained", err)
	}
	for _, scenario := range []string{"pending", "locked", "unowned"} {
		for _, name := range []string{installerName, installerReceipt} {
			if _, err := os.Stat(filepath.Join(cache, "installer-"+scenario, name)); err != nil {
				t.Fatal("unsafe early cleanup", scenario, name, err)
			}
		}
	}
	if data, err := os.ReadFile(filepath.Join(cache, "installer-extra file", "user-data")); err != nil || string(data) != "preserve" {
		t.Fatal("removed unknown data", err)
	}
	if data, err := os.ReadFile(outsideImage); err != nil || string(data) != "outside" {
		t.Fatal("followed symlink outside cache", err)
	}
	if err := cleanupInstallers(cache, func(root *os.Root, image string) error { return root.Remove(image) }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cache, "installer-locked")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unlocked image not reclaimed on next attempt", err)
	}
}
