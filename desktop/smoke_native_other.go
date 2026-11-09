//go:build !windows

package main

func smokeNativePlatform(uintptr) smokePlatformState {
	return smokePlatformState{Apartment: "not-applicable"}
}
