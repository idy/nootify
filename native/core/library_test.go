package core

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestDirectTailnetDialReachesAuthenticatedRPCWithoutStdio(t *testing.T) {
	upstream := testCore(t, nil)
	address, token := testServer(t, upstream)
	var events, dials atomic.Int32
	downstream := testCore(t, func(string, any) error { events.Add(1); return nil })
	must(t, downstream.store.Update(func(d *State) error { d.Tailnet = true; return nil }))
	downstream.SetTailnetDialer(func(ctx context.Context, network, target string) (net.Conn, error) {
		dials.Add(1)
		if network != "tcp" || target != "peer.example.ts.net:9418" {
			t.Errorf("incorrect embedded dial: %s %s", network, target)
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	})
	p := newRemoteProvider(downstream, ProviderConfig{ID: "direct", Address: "peer.example.ts.net:9418", Token: token})
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// A forbidden private method proves authentication reached the real gRPC
	// server without granting that method to remote clients.
	err := p.call(ctx, "status", map[string]any{}, nil)
	if PublicError(err).Code != "permission_denied" || dials.Load() != 1 || events.Load() != 0 {
		t.Fatalf("direct encrypted transport: err=%v dials=%d events=%d", err, dials.Load(), events.Load())
	}
}

func TestDirectTailnetDialFailureDoesNotFallBackToHostOrStdio(t *testing.T) {
	var events atomic.Int32
	c := testCore(t, func(string, any) error { events.Add(1); return nil })
	must(t, c.store.Update(func(d *State) error { d.Tailnet = true; return nil }))
	c.SetTailnetDialer(func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("private backend detail")
	})
	conn, err := c.dial(context.Background(), "peer.example.ts.net:9418")
	if conn != nil || err == nil || err.Error() != "embedded tailnet dial failed" || events.Load() != 0 {
		t.Fatalf("failed embedded dial escaped: conn=%v err=%v events=%d", conn, err, events.Load())
	}
}

func TestCoreCloseCancelsDirectTailnetDial(t *testing.T) {
	c := testCore(t, nil)
	must(t, c.store.Update(func(d *State) error { d.Tailnet = true; return nil }))
	entered := make(chan struct{})
	c.SetTailnetDialer(func(ctx context.Context, _, _ string) (net.Conn, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = c.dial(context.Background(), "100.64.0.2:9418")
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("direct dial did not start")
	}
	c.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("core shutdown did not cancel embedded dial")
	}
}

func TestPublicErrorAndDirectHandlePreserveSafeProtocolErrors(t *testing.T) {
	c := testCore(t, nil)
	_, err := c.Handle(context.Background(), "remote.secret", json.RawMessage(`{}`), false)
	if PublicError(err).Code != "permission_denied" {
		t.Fatalf("library bypassed remote method restrictions: %v", err)
	}
	if PublicError(nil) != nil || PublicError(errors.New("private credential")).Message != "operation failed; retry when the provider is available" {
		t.Fatal("public errors leaked internal details or changed nil semantics")
	}
}
