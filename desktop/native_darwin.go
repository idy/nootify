package main

import (
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

// The navigation policy calls this only for the fixed request of a trusted page.
// Native NSWindow is a documented MyGo handle. Never dispatch arbitrary selectors.
func startWindowDrag(window *mygo.Window) {
	mygo.RunOnMain(func() {
		app := objc.ID(objc.GetClass("NSApplication")).Send(objc.RegisterName("sharedApplication"))
		event := app.Send(objc.RegisterName("currentEvent"))
		if event == 0 {
			return
		}
		kind := event.Send(objc.RegisterName("type"))
		if kind != 1 && kind != 6 {
			return
		}
		if event.Send(objc.RegisterName("window")) != objc.ID(window.NativeHandle()) {
			return
		}
		objc.ID(window.NativeHandle()).Send(objc.RegisterName("performWindowDragWithEvent:"), event)
	})
}
func nativeStartupError(string)            {}
func configureNativeIdentity(string) error { return nil }
