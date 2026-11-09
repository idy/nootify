//go:build !windows

package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"sync"
)

const localTunnelNetwork = "unix"

type localTunnelListener struct {
	*net.UnixListener
	dir  string
	once sync.Once
	err  error
}

func (l *localTunnelListener) Close() error {
	l.once.Do(func() {
		l.err = l.UnixListener.Close() // also unlinks the socket
		if err := os.Remove(l.dir); l.err == nil {
			l.err = err
		}
	})
	return l.err
}

func listenLocalTunnel(ctx context.Context) (net.Listener, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	base := os.TempDir()
	// Unix socket paths have a short OS-specific bound (104 bytes on Darwin).
	// A private random directory under /tmp also works with a long TMPDIR.
	if len(filepath.Join(base, "nt-0000000000", "s")) > 100 {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "nt-") // created 0700 before any endpoint exists
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		os.Remove(dir)
		return nil, err
	}
	path := filepath.Join(dir, "s")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		os.Remove(dir)
		return nil, err
	}
	owned := &localTunnelListener{UnixListener: listener, dir: dir}
	if err := os.Chmod(path, 0600); err != nil {
		owned.Close()
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		owned.Close()
		return nil, err
	}
	return owned, nil
}
