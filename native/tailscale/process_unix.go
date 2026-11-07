//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// Opt into the runtime poller for the parent's anonymous pipe, as os.Pipe does.
// Darwin's /dev/fd duplication does not apply the Open flags to the pipe.
func openProcessStdin() (*os.File, error) {
	info, err := os.Stdin.Stat()
	if err != nil {
		return nil, err
	}
	if info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return os.Stdin, nil
	}
	fd, err := syscall.Open("/dev/stdin", syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), "/dev/stdin"), nil
}

func prepareProcess() {
	// Protect files created by dependencies too. A disappearing parent should
	// produce EPIPE, allowing normal cleanup instead of immediate termination.
	syscall.Umask(0077)
	signal.Ignore(syscall.SIGPIPE)
}
