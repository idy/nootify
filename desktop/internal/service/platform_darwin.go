package service

import (
	"golang.org/x/sys/unix"
	"os/exec"
)

func hideConsole(*exec.Cmd) {}
func readOnlyVolume(path string) bool {
	var stat unix.Statfs_t
	return unix.Statfs(path, &stat) == nil && stat.Flags&unix.MNT_RDONLY != 0
}
