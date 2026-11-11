//go:build !windows

package privatepath

import (
	"errors"
	"os"
	"syscall"
)

// Protect verifies a user-owned, unredirected object and applies Unix private
// directory/file modes. Files shared through hard links are never modified.
func Protect(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return errors.New("refusing redirected or mismatched private object")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || (!directory && stat.Nlink != 1) {
		return errors.New("refusing private object owned by another user or shared through links")
	}
	mode := os.FileMode(0600)
	if directory {
		mode = 0700
	}
	return os.Chmod(path, mode)
}
