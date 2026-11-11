package storage

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestInitialTokenPublicationIsAtomicForConcurrentCreators(t *testing.T) {
	for round := 0; round < 4; round++ {
		dir := t.TempDir()
		path := filepath.Join(dir, "auth-token")
		const writers = 64
		start := make(chan struct{})
		tokens := make(chan string, writers)
		errs := make(chan error, writers)
		var wg sync.WaitGroup
		for i := 0; i < writers; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); <-start; token, err := privateToken(path); tokens <- token; errs <- err }()
		}
		close(start)
		wg.Wait()
		close(tokens)
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal("reader observed incomplete token", err)
			}
		}
		first := ""
		for token := range tokens {
			if first == "" {
				first = token
			}
			if token != first {
				t.Fatal("concurrent startup changed service identity")
			}
			raw, err := hex.DecodeString(token)
			if err != nil || len(raw) != 32 {
				t.Fatal("invalid published token")
			}
		}
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) != 1 || entries[0].Name() != "auth-token" {
			t.Fatal("temporary token publication files leaked", entries, err)
		}
	}
}
