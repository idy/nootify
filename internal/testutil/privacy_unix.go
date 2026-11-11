//go:build !windows

package testutil

import (
	"fmt"
	"os"
)

// CheckPrivatePath checks the platform's access controls on a test artifact.
// Unix permissions must match the file or directory mode requested by its writer.
func CheckPrivatePath(path string, mode os.FileMode) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm() != mode {
		return fmt.Errorf("private path %s: mode %04o, want %04o", path, info.Mode().Perm(), mode)
	}
	return nil
}
