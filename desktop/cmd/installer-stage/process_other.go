//go:build !windows

package main

import (
	"os"
	"os/exec"
)

func lockTransaction() (func(), error)               { return func() {}, nil }
func configureCommand(cmd *exec.Cmd) error           { return nil }
func renameJournal(source, destination string) error { return os.Rename(source, destination) }
func renamePayload(source, destination string) error { return os.Rename(source, destination) }
