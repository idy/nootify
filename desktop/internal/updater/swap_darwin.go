package updater

import "golang.org/x/sys/unix"

func swapBundles(a, b string) error { return unix.RenamexNp(a, b, unix.RENAME_SWAP) }
