//go:build !windows

package updater

import "errors"

func launchInstaller(path string, args []string) error {
	return errors.New("Windows installer launch requires Windows")
}
