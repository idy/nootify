package host

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

type blockedAssets struct {
	once             sync.Once
	entered, release chan struct{}
	files            fstest.MapFS
}

func (f *blockedAssets) Open(name string) (fs.File, error) {
	f.once.Do(func() { close(f.entered) })
	<-f.release
	return f.files.Open(name)
}
func TestShutdownJoinsAdmittedHandlerBeforeClosingState(t *testing.T) {
	isolate(t)
	files := &blockedAssets{entered: make(chan struct{}), release: make(chan struct{}), files: fstest.MapFS{"index.html": {Data: []byte("trusted-assets")}}}
	s, err := New(context.Background(), Options{StateDir: t.TempDir(), Home: t.TempDir(), Port: 0, Assets: files})
	if err != nil {
		t.Fatal(err)
	}
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		response, err := http.Get(s.URL() + "/")
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
		}
	}()
	select {
	case <-files.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not start")
	}
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	select {
	case err := <-closed:
		close(files.release)
		t.Fatalf("shutdown released state before admitted handler: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if _, err := s.store.Rows("settings"); err != nil {
		close(files.release)
		t.Fatal("state closed while handler still running", err)
	}
	close(files.release)
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not join completed handler")
	}
	<-requestDone
}
