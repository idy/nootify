//go:build !windows

package main

import (
	"os"
	"os/exec"
)

func lockTransaction() (func(), error)               { return func() {}, nil }
func hideWindow(cmd *exec.Cmd)                       {}
func renameJournal(source, destination string) error { return os.Rename(source, destination) }
func renamePayload(source, destination string) error { return os.Rename(source, destination) }
