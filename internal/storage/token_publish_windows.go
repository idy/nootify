package storage

import "golang.org/x/sys/windows"

// Do not use REPLACE_EXISTING: a concurrent creator must retain the winning
// identity. Move also avoids exposing a legitimate transient second hard link
// to Windows private-file ownership/link validation.
func publishToken(from, to string) error {
	source, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(source, target, windows.MOVEFILE_WRITE_THROUGH)
}
