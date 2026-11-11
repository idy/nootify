//go:build !windows

package service

import (
	"context"
	"errors"
	"syscall"
)

func manageWindows(context.Context, string, Options) (any, error) {
	return nil, errors.New("Windows service management requires Windows")
}
func PrepareServe(context.Context, Options) (func() error, error) {
	return func() error { return nil }, nil
}
func processAbsent(pid int) bool { return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) }
