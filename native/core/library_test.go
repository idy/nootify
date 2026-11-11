package core

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func TestDirectTCPReachesAuthenticatedRPCWithoutStdio(t *testing.T) {
	upstream := testCore(t, nil)
	address, token := testServer(t, upstream)
	var events atomic.Int32
	downstream := testCore(t, func(string, any) error { events.Add(1); return nil })
	p := newRemoteProvider(downstream, ProviderConfig{ID: "direct", Address: address, Token: token})
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// A forbidden private method proves authentication reached the real gRPC
	// server without granting that method to remote clients.
	err := p.call(ctx, "status", map[string]any{}, nil)
	if PublicError(err).Code != "permission_denied" || events.Load() != 0 {
		t.Fatalf("direct TCP transport: err=%v events=%d", err, events.Load())
	}
}

func TestDirectTCPDialFailureDoesNotEmitBridgeRequests(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	address := listener.Addr().String()
	must(t, listener.Close())
	var events atomic.Int32
	c := testCore(t, func(string, any) error { events.Add(1); return nil })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := c.dial(ctx, address)
	if conn != nil || err == nil || events.Load() != 0 {
		t.Fatalf("failed direct dial: conn=%v err=%v events=%d", conn, err, events.Load())
	}
}

func TestCoreClosePreventsDirectTCPDial(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	defer listener.Close()
	c := testCore(t, nil)
	c.Close()
	conn, err := c.dial(context.Background(), listener.Addr().String())
	if conn != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("closed core dialed: conn=%v err=%v", conn, err)
	}
}

func TestOldTransportStateIsIgnoredWithoutChangingDurableState(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	must(t, err)
	defer store.Close()
	// Retention normally refreshes pending-work ages on every open. Give the
	// fixture a future age so reopening can compare the entire state exactly.
	retainedAt := time.Now().Add(time.Hour)
	store.clock = func() time.Time { return retainedAt }
	must(t, store.Update(func(d *State) error {
		d.Providers["lan"] = ProviderConfig{ID: "lan", Name: "LAN", Type: "remote", Address: "192.168.1.2:9418", Token: "provider-token"}
		d.DefaultProvider = "lan"
		d.Remote = RemoteConfig{Listen: "0.0.0.0:9418", Token: "listener-token"}
		d.Migrated = true
		session := Session{NodeID: d.NodeID, Adapter: "codex", SessionID: "preserved", Metadata: map[string]any{"label": "keep"}}
		d.Bindings[session.key()] = Binding{ProviderID: "lan", Session: session, ChatID: "retained-chat"}
		event := eventFor("elsewhere", "retained-event")
		d.Events[event.ID] = EventRecord{Event: event, Outcome: "broadcast"}
		d.Peers["peer"] = Peer{NodeID: "peer", Pending: []string{event.ID}}
		d.Deliveries["delivery"] = Delivery{ID: "delivery", EventID: event.ID, Status: "unconfirmed"}
		remember(d, event.Message, "lan")
		d.Operations["retry"] = Operation{State: "retryable", RequestID: "retained-request", Fingerprint: "retained-fingerprint"}
		return nil
	}))
	before := store.Snapshot()
	must(t, store.Close())
	raw, err := json.Marshal(before)
	must(t, err)
	var legacy map[string]json.RawMessage
	must(t, json.Unmarshal(raw, &legacy))
	legacy["tailnet_enabled"] = json.RawMessage(`true`)
	raw, err = json.Marshal(legacy)
	must(t, err)
	path := filepath.Join(dir, "state.json")
	must(t, os.WriteFile(path, raw, 0600))
	reopened, err := OpenStore(dir)
	must(t, err)
	defer reopened.Close()
	if after := reopened.Snapshot(); !reflect.DeepEqual(before, after) {
		want, got := reflect.ValueOf(before), reflect.ValueOf(after)
		for i := 0; i < want.NumField(); i++ {
			if !reflect.DeepEqual(want.Field(i).Interface(), got.Field(i).Interface()) {
				t.Errorf("obsolete transport state changed %s", want.Type().Field(i).Name)
			}
		}
	}
	raw, err = os.ReadFile(path)
	must(t, err)
	var persisted map[string]json.RawMessage
	must(t, json.Unmarshal(raw, &persisted))
	if _, present := persisted["tailnet_enabled"]; present {
		t.Fatal("obsolete transport field was retained in the new state")
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
