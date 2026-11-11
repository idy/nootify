//go:build !windows

package core

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func testPrivateTunnelListener(t *testing.T) net.Listener {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nt-core-")
	must(t, err)
	path := filepath.Join(dir, "s")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		os.Remove(dir)
		t.Fatal(err)
	}
	must(t, os.Chmod(path, 0600))
	t.Cleanup(func() { listener.Close(); os.Remove(dir) })
	return listener
}

func TestEmbeddedUnixEndpointRejectsSharedPermissionsAndNonSockets(t *testing.T) {
	listener := testPrivateTunnelListener(t)
	address := listener.Addr().String()
	if !validEmbeddedEndpoint("unix", address) {
		t.Fatal("private owner-only Unix socket rejected")
	}
	for _, tc := range []struct {
		path string
		mode os.FileMode
	}{
		{filepath.Dir(address), 0755},
		{filepath.Dir(address), 0710},
		{address, 0660},
		{address, 0666},
	} {
		original, err := os.Lstat(tc.path)
		must(t, err)
		must(t, os.Chmod(tc.path, tc.mode))
		if validEmbeddedEndpoint("unix", address) {
			t.Fatal("endpoint exposing group/other access was accepted")
		}
		if conn, err := dialEmbeddedEndpoint(context.Background(), "unix", address); err == nil {
			conn.Close()
			t.Fatal("endpoint permission failure still opened a stream")
		}
		must(t, os.Chmod(tc.path, original.Mode().Perm()))
	}
	ordinary := filepath.Join(filepath.Dir(address), "file")
	must(t, os.WriteFile(ordinary, []byte("private"), 0600))
	defer os.Remove(ordinary)
	if validEmbeddedEndpoint("unix", ordinary) {
		t.Fatal("ordinary file accepted as a tunnel endpoint")
	}
	linked := filepath.Join(filepath.Dir(address), "link")
	must(t, os.Symlink(address, linked))
	defer os.Remove(linked)
	if validEmbeddedEndpoint("unix", linked) {
		t.Fatal("symlink accepted as a tunnel endpoint")
	}
	for _, network := range []string{"", "tcp", "tcp4", "npipe"} {
		if validEmbeddedEndpoint(network, address) {
			t.Fatal("non-private endpoint network accepted")
		}
	}
	for _, address := range []string{"127.0.0.1:12345", "relative/s", "/tmp/a/../s", "/tmp/invalid\x00name"} {
		if validEmbeddedEndpoint("unix", address) {
			t.Fatal("non-canonical private endpoint accepted")
		}
	}
}
