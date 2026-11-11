//go:build !windows

package tailscale

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func dialLocalTunnelFixture(ctx context.Context, address string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", address)
}

func TestUnixTunnelEndpointIsOwnerOnlyAndRemovedOnClose(t *testing.T) {
	listener, err := listenLocalTunnel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	address := listener.Addr().String()
	if listener.Addr().Network() != "unix" || !filepath.IsAbs(address) {
		t.Fatal("tunnel is not a private Unix socket")
	}
	for path, want := range map[string]os.FileMode{address: 0600, filepath.Dir(address): 0700} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		owner, ok := info.Sys().(*syscall.Stat_t)
		if !ok || owner.Uid != uint32(os.Geteuid()) || info.Mode().Perm() != want {
			t.Fatal("private endpoint permissions do not restrict access to the owner")
		}
		// These are the OS discretionary permission bits: neither group nor
		// other users can traverse the directory or access its socket.
		if info.Mode().Perm()&0077 != 0 || info.Mode()&os.ModeSymlink != 0 {
			t.Fatal("another local user can reach the tunnel admission queue")
		}
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{address, filepath.Dir(address)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("closed tunnel retained its private endpoint")
		}
	}
	if err := listener.Close(); err != nil {
		t.Fatal("private endpoint close is not idempotent")
	}
}

func TestUnixTunnelLongTempPathAndCanceledAllocation(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), strings.Repeat("long", 40)))
	listener, err := listenLocalTunnel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if len(listener.Addr().String()) > 100 {
		t.Fatal("Unix socket did not bound its address length")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if listener, err := listenLocalTunnel(ctx); err == nil || listener != nil {
		if listener != nil {
			listener.Close()
		}
		t.Fatal("canceled allocation created an endpoint")
	}
}
