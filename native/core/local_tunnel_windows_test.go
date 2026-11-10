package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"strings"
	"testing"
	"time"

	winio "github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
)

func testWindowsTunnelListener(t *testing.T, broad bool) net.Listener {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	must(t, err)
	sid := user.User.Sid.String()
	grantee := sid
	if broad {
		grantee = "WD"
	}
	var id [16]byte
	rand.Read(id[:])
	listener, err := winio.ListenPipe(localTunnelPipePrefix+hex.EncodeToString(id[:]), &winio.PipeConfig{
		SecurityDescriptor: "O:" + sid + "D:P(A;;GA;;;" + grantee + ")", MessageMode: true,
	})
	must(t, err)
	t.Cleanup(func() { listener.Close() })
	return listener
}

func testPrivateTunnelListener(t *testing.T) net.Listener {
	return testWindowsTunnelListener(t, false)
}

func TestEmbeddedWindowsEndpointRejectsSharedPipeDACL(t *testing.T) {
	listener := testWindowsTunnelListener(t, true)
	accepted := make(chan net.Conn, 1)
	go func() { conn, _ := listener.Accept(); accepted <- conn }()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if conn, err := dialEmbeddedEndpoint(ctx, "npipe", listener.Addr().String()); err == nil {
		conn.Close()
		t.Fatal("broadly accessible pipe accepted as an owner-only endpoint")
	}
	select {
	case server := <-accepted:
		if server == nil {
			t.Fatal("synthetic pipe accept failed")
		}
		defer server.Close()
		server.SetReadDeadline(time.Now().Add(time.Second))
		var data [1]byte
		if n, err := server.Read(data[:]); n != 0 || err == nil {
			t.Fatal("untrusted pipe received bytes before owner verification")
		}
	case <-ctx.Done():
		t.Fatal("synthetic pipe did not accept")
	}
}

func TestEmbeddedWindowsEndpointRequiresCanonicalLocalPipeName(t *testing.T) {
	name := localTunnelPipePrefix + strings.Repeat("ab", 16)
	if !validEmbeddedEndpoint("npipe", name) {
		t.Fatal("canonical private pipe name rejected")
	}
	for _, network := range []string{"", "tcp", "unix"} {
		if validEmbeddedEndpoint(network, name) {
			t.Fatal("wrong private transport network accepted")
		}
	}
	for _, path := range []string{
		"127.0.0.1:12345", `\\server\pipe\nootify-tunnel-` + strings.Repeat("ab", 16),
		`\\.\pipe\other-` + strings.Repeat("ab", 16), name + `\child`, name + "\x00",
		localTunnelPipePrefix + strings.Repeat("AB", 16), localTunnelPipePrefix + "short",
	} {
		if validEmbeddedEndpoint("npipe", path) {
			t.Fatal("arbitrary pipe or TCP address accepted")
		}
	}
}
