package core

import (
	"io"
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func prefillStdioPipe(t *testing.T, reader, writer *os.File) {
	t.Helper()
	// Windows anonymous pipes do not support Go write deadlines. Their read
	// handle is the inbound server end of a named pipe: query its actual quota
	// and fill it exactly, leaving no room for the child's ready frame.
	var capacity uint32
	must(t, windows.GetNamedPipeInfo(windows.Handle(reader.Fd()), nil, nil, &capacity, nil))
	if capacity == 0 || capacity > 32<<20 {
		t.Fatalf("unexpected stdout pipe capacity: %d", capacity)
	}
	must(t, awaitStdioIO(t, func() error {
		n, err := writer.Write(make([]byte, int(capacity)))
		if err == nil && n != int(capacity) {
			err = io.ErrShortWrite
		}
		return err
	}))
}
