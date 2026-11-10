//go:build !windows

package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const localTunnelNetwork = "unix"

func validEmbeddedEndpoint(network, address string) bool {
	if network != localTunnelNetwork || !filepath.IsAbs(address) || filepath.Clean(address) != address || strings.ContainsRune(address, 0) {
		return false
	}
	for path, mode := range map[string]os.FileMode{filepath.Dir(address): 0700, address: 0600} {
		info, err := os.Lstat(path)
		if err != nil || info.Mode().Perm() != mode || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		if path == address && info.Mode()&os.ModeSocket == 0 || path != address && !info.IsDir() {
			return false
		}
		owner, ok := info.Sys().(*syscall.Stat_t)
		if !ok || owner.Uid != uint32(os.Geteuid()) {
			return false
		}
	}
	return true
}

func dialEmbeddedEndpoint(ctx context.Context, network, address string) (net.Conn, error) {
	if !validEmbeddedEndpoint(network, address) {
		return nil, fault("unavailable", "private tunnel endpoint is unavailable")
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", address)
	if err != nil {
		return nil, fault("unavailable", "private tunnel endpoint is unavailable")
	}
	return conn, nil
}
