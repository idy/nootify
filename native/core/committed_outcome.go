package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
)

// committedStateError means the atomic replacement and in-memory publication
// succeeded, but the directory durability barrier did not. The mutation must
// not be rolled back in live configuration or blindly submitted again. It may
// survive an ordinary restart; persistence across a system crash is unconfirmed.
// Keep the underlying filesystem error available without reporting success.
type committedStateError struct{ cause error }

func (e *committedStateError) Error() string {
	return fmt.Sprintf("state mutation committed, but filesystem durability was not confirmed: %v", e.cause)
}
func (e *committedStateError) Unwrap() error { return e.cause }

// stateCommitted distinguishes an unapplied transaction from a published one.
// Callers still return/log the original error after reconciling live effects.
// In particular, a committed pending intent with an error does not authorize a
// provider submission: that intent's crash durability has not been confirmed.
func stateCommitted(err error) bool {
	var committed *committedStateError
	return err == nil || errors.As(err, &committed)
}

func syncStateDirectory(path string) error {
	if runtime.GOOS == "windows" {
		// replaceStateFile uses MOVEFILE_WRITE_THROUGH on Windows.
		return nil
	}
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	err = dir.Sync()
	closeErr := dir.Close()
	if err != nil {
		return err
	}
	return closeErr
}
