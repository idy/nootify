package service

import (
	"os/exec"
	"syscall"
)

func hideConsole(cmd *exec.Cmd)  { cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} }
func readOnlyVolume(string) bool { return false }
