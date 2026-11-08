//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

func privateStatePath(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return fmt.Errorf("unsafe state object")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || (!directory && stat.Nlink != 1) {
		return fmt.Errorf("unsafe state owner or links")
	}
	mode := os.FileMode(0600)
	if directory {
		mode = 0700
	}
	return os.Chmod(path, mode)
}
func replaceStateFile(from, to string) error { return os.Rename(from, to) }
