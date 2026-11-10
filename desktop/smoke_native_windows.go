package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// This reads the existing UI apartment and HWND owner. It never initializes COM,
// creates a WebView environment/controller, or changes native application state.
func smokeNativePlatform(handle uintptr) smokePlatformState {
	const notImplemented uint32 = 0x80004001
	hr := notImplemented
	apartment, qualifier := int32(-1), int32(-1)
	proc := windows.NewLazySystemDLL("ole32.dll").NewProc("CoGetApartmentType")
	if proc.Find() == nil {
		result, _, _ := proc.Call(uintptr(unsafe.Pointer(&apartment)), uintptr(unsafe.Pointer(&qualifier)))
		hr = uint32(result)
	}
	var process uint32
	owner, err := windows.GetWindowThreadProcessId(windows.HWND(handle), &process)
	known := handle != 0 && err == nil && owner != 0
	return smokePlatformState{Supported: true, ApartmentHRESULT: hr, Apartment: smokeApartment(hr, apartment), WindowThreadKnown: known, UIThreadOwnsWindow: known && owner == windows.GetCurrentThreadId()}
}
