package main

import (
	"errors"
	"os/exec"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var moveFileEx = kernel32.NewProc("MoveFileExW")

func lockTransaction() (func(), error) {
	name, _ := syscall.UTF16PtrFromString(`Global\Nootify.Installer.Transaction`)
	handle, _, failure := kernel32.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, errors.New("cannot lock installer transaction")
	}
	if failure == syscall.ERROR_ALREADY_EXISTS {
		syscall.CloseHandle(syscall.Handle(handle))
		return nil, errors.New("another installer transaction helper is still running; retry later")
	}
	return func() { syscall.CloseHandle(syscall.Handle(handle)) }, nil
}

func configureCommand(cmd *exec.Cmd) error {
	// NSIS runs from its plugin directory, which contains a native System.dll.
	// Legacy PowerShell Add-Type resolves bare framework references from CWD.
	// Use the OS system directory, independent of inherited environment values.
	var directory [32768]uint16
	length, _, _ := kernel32.NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&directory[0])), uintptr(len(directory)))
	if length == 0 || length >= uintptr(len(directory)) {
		return errors.New("cannot resolve the Windows system command directory")
	}
	cmd.Dir = syscall.UTF16ToString(directory[:length])
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return nil
}

func move(source, destination string, flags uintptr) error {
	from, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	result, _, failure := moveFileEx.Call(uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(to)), flags)
	if result == 0 {
		return failure
	}
	return nil
}

func renameJournal(source, destination string) error { return move(source, destination, 0x9) } // REPLACE_EXISTING | WRITE_THROUGH
func renamePayload(source, destination string) error { return move(source, destination, 0x8) } // WRITE_THROUGH; never overwrite a destination
