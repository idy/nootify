// Package public contains the browser UI embedded in the Nootify executable.
// Run npm run build before a Go build or test to refresh the generated ui tree.
package public

import "embed"

//go:embed index.html styles.css ui/**
var FS embed.FS
