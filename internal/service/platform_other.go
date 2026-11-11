//go:build !darwin && !windows

package service

import "os/exec"

func hideConsole(*exec.Cmd)      {}
func readOnlyVolume(string) bool { return false }
