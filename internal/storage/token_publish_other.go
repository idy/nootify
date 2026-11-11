//go:build !windows

package storage

import "os"

// Link publishes a complete file exclusively; the caller removes the temporary
// name. Readers never observe an empty token and an existing identity wins.
func publishToken(from, to string) error { return os.Link(from, to) }
