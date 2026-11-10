//go:build !darwin

package updater

import "errors"

func swapBundles(a, b string) error {
	return errors.New("atomic app replacement is only supported on macOS")
}
