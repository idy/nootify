//go:build !darwin && !windows

package main

import "github.com/egoist/mygo"

func startWindowDrag(*mygo.Window)         {}
func nativeStartupError(string)            {}
func configureNativeIdentity(string) error { return nil }
