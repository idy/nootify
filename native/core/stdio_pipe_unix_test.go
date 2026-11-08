//go:build !windows

package main

import (
	"errors"
	"os"
	"testing"
	"time"
)

func prefillStdioPipe(t *testing.T, _ *os.File, writer *os.File) {
	t.Helper()
	must(t, writer.SetWriteDeadline(time.Now().Add(50*time.Millisecond)))
	_, err := writer.Write(make([]byte, 2<<20))
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("could not fill stdout pipe: %v", err)
	}
	must(t, writer.SetWriteDeadline(time.Time{}))
}
