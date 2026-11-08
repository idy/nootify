package main

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestTailnetAddressForms(t *testing.T) {
	for address, want := range map[string]bool{
		"100.64.0.2:7443":               true,
		"[::ffff:100.64.0.2]:7443":      true,
		"[::ffff:100.127.255.254]:9418": true,
		"[fd7a:115c:a1e0::2]:9418":      true,
		"node.example.ts.net:9418":      true,
		"[::ffff:192.168.1.2]:7443":     false,
		"[::ffff:127.0.0.1]:7443":       false,
		"[::ffff:100.128.0.1]:7443":     false,
		"[fd7a:115c:a1e1::2]:9418":      false,
		"localhost:9418":                false,
		"malformed":                     false,
	} {
		if got := isTailnet(address); got != want {
			t.Errorf("isTailnet(%q) = %v, want %v", address, got, want)
		}
	}
}

func TestMappedTailnetDialUsesEmbeddedTunnel(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	defer listener.Close()
	var core *Core
	var requested string
	core = testCore(t, func(event string, data any) error {
		if event != "dial" {
			return nil
		}
		fields := data.(map[string]any)
		requested = fields["address"].(string)
		return core.completeDial(fields["request_id"].(string), listener.Addr().String(), "")
	})
	must(t, core.store.Update(func(state *State) error { state.Tailnet = true; return nil }))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	address := "[::ffff:100.64.0.2]:7443"
	conn, err := core.dial(ctx, address)
	must(t, err)
	defer conn.Close()
	if requested != address || conn.RemoteAddr().String() != listener.Addr().String() {
		t.Fatalf("mapped Tailnet destination bypassed the embedded tunnel: request=%q remote=%s", requested, conn.RemoteAddr())
	}
}
