package updater

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const installerName = "Nootify-setup.exe"
const installerReceipt = "handoff"
const installerPending = "nootify-installer-pending-v1\n"
const installerOpened = "nootify-installer-opened-v1\n"

func installerCache() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "dev.idy.nootify", "updates"), nil
}

// CleanupInstallers removes only acknowledged, unlocked updater images from the
// private cache. Pending handoffs are retained: ShellExecute can return before an
// installer opens its image. NSIS acknowledges from .onInit, while its image is locked.
// Run on a later desktop start; it is independent of service/update ownership.
func CleanupInstallers() error {
	root, err := installerCache()
	if err != nil {
		return err
	}
	return cleanupInstallers(root, func(root *os.Root, image string) error {
		// On Windows DeleteFile refuses a mapped executable or a handle that
		// denies delete sharing. No POSIX unlink semantics or forced deletion.
		return root.Remove(image)
	})
}

func cleanupInstallers(directory string, removeImage func(*os.Root, string) error) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("installer cache is not a real directory")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "installer-") {
			continue
		}
		receipt := filepath.Join(entry.Name(), installerReceipt)
		image := filepath.Join(entry.Name(), installerName)
		// Reject links, unknown files and directories before touching their contents.
		ri, err := root.Lstat(receipt)
		if err != nil || !ri.Mode().IsRegular() || ri.Size() != int64(len(installerOpened)) {
			continue
		}
		data, err := root.ReadFile(receipt)
		if err != nil || string(data) != installerOpened {
			continue
		}
		ii, err := root.Lstat(image)
		if err == nil {
			if !ii.Mode().IsRegular() || removeImage(root, image) != nil {
				continue // A mapped/in-use installer must survive until a later start.
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			continue
		}
		_ = root.Remove(receipt)
		// Nonrecursive: an unexpected file, including user data, retains the directory.
		_ = root.Remove(entry.Name())
	}
	return nil
}
