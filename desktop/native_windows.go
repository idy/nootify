package main

import (
	"fmt"
	"github.com/egoist/mygo"
	"golang.org/x/sys/windows"
	"unsafe"
)

var nativeUser32 = windows.NewLazySystemDLL("user32.dll")

func configureNativeIdentity(identity string) error {
	id, err := windows.UTF16PtrFromString(identity)
	if err != nil {
		return err
	}
	result, _, _ := windows.NewLazySystemDLL("shell32.dll").NewProc("SetCurrentProcessExplicitAppUserModelID").Call(uintptr(unsafe.Pointer(id)))
	if int32(result) < 0 {
		return fmt.Errorf("cannot set Windows application identity: HRESULT 0x%x", result)
	}
	return nil
}

func startWindowDrag(window *mygo.Window) {
	mygo.RunOnMain(func() {
		_, _, _ = nativeUser32.NewProc("ReleaseCapture").Call()
		_, _, _ = nativeUser32.NewProc("SendMessageW").Call(window.NativeHandle(), 0x00A1, 2, 0)
	})
}
func nativeStartupError(message string) {
	text, _ := windows.UTF16PtrFromString("Nootify could not start. Ensure the Microsoft Edge WebView2 Runtime is installed.\n\n" + message)
	title, _ := windows.UTF16PtrFromString("Nootify")
	_, _, _ = nativeUser32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}
