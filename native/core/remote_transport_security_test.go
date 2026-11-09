package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

func TestRemotePlaintextTransportRequiresNumericLoopbackOrVerifiedBridge(t *testing.T) {
	for _, tc := range []struct {
		address string
		tls     bool
		allowed bool
	}{
		{"127.0.0.1:9418", false, true},
		{"[::1]:9418", false, true},
		{"[::ffff:127.0.0.1]:9418", false, true},
		{"localhost:9418", false, false},
		{"example.invalid:9418", false, false},
		{"192.0.2.42:9418", false, false},
		{"10.0.0.1:9418", false, false},
		{"192.0.2.42:9418", true, true},
		{"peer.example.ts.net:9418", false, true}, // Eligible only; runtime proof required.
		{"100.64.0.1:9418", false, true},
	} {
		t.Run(tc.address, func(t *testing.T) {
			err := validateRemoteTransport(ProviderConfig{Address: tc.address, TLS: tc.tls})
			if (err == nil) != tc.allowed {
				t.Fatalf("transport eligibility = %v; allowed %v", err, tc.allowed)
			}
		})
	}
	// Even a DNS name resolving to loopback is rejected before opening a
	// connection or attaching bearer metadata to an HTTP/2 request.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	defer listener.Close()
	_, port, err := net.SplitHostPort(listener.Addr().String())
	must(t, err)
	c := testCore(t, nil)
	p := newRemoteProvider(c, ProviderConfig{ID: "unsafe", Address: "localhost:" + port, Token: "must-not-cross-wire"})
	defer p.Close()
	if p.initErr == nil {
		t.Fatal("unsafe plaintext client was constructed")
	}
	err = p.call(context.Background(), "message.send", map[string]any{}, nil)
	if publicError(err).Code != "rejection_retryable" {
		t.Fatal("local transport rejection lost pre-submission proof")
	}
	must(t, listener.(*net.TCPListener).SetDeadline(time.Now().Add(50*time.Millisecond)))
	conn, err := listener.Accept()
	if conn != nil {
		conn.Close()
		t.Fatal("unsafe client opened a connection")
	}
	if e, ok := err.(net.Error); !ok || !e.Timeout() {
		t.Fatalf("unexpected accept result: %v", err)
	}
}

func TestRemotePlaintextCredentialsRejectGenericLoopbackForward(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	must(t, err)
	server, err := listener.Accept()
	must(t, err)
	defer server.Close()
	guard := guardedRemoteCredentials{TransportCredentials: insecure.NewCredentials(), loopback: false}
	_, _, err = guard.ClientHandshake(context.Background(), "peer.example.ts.net:9418", client)
	if err == nil {
		t.Fatal("generic local forward was mistaken for a verified encrypted bridge")
	}
	must(t, server.SetReadDeadline(time.Now().Add(time.Second)))
	var b [1024]byte
	if n, err := server.Read(b[:]); n != 0 || err == nil {
		t.Fatal("unverified forwarding socket received HTTP/2 bytes")
	}
}

func TestRemotePlaintextUsesMatchingPrivateEmbeddedBridge(t *testing.T) {
	upstream := testCore(t, nil)
	address, token := testServer(t, upstream)
	bridge := testAuthenticatedTunnelBridge(t, address)
	var downstream *Core
	var requests atomic.Int32
	downstream = testCore(t, func(name string, data any) error {
		if name != "dial" {
			return nil
		}
		requests.Add(1)
		request := data.(map[string]any)
		if request["address"] != "peer.example.ts.net:9418" {
			t.Error("bridge target was not preserved")
			return errors.New("wrong synthetic bridge target")
		}
		return downstream.completeDial(request["request_id"].(string), bridge, "", fixtureTunnelToken)
	})
	must(t, downstream.store.Update(func(d *State) error { d.Tailnet = true; return nil }))
	p := newRemoteProvider(downstream, ProviderConfig{ID: "bridge", Name: "Bridge", Address: "peer.example.ts.net:9418", Token: token})
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// A private-method Result proves the verified transport delivered auth
	// metadata, while the method itself is still forbidden over remote RPC.
	err := p.call(ctx, "status", map[string]any{}, nil)
	if publicError(err).Code != "permission_denied" || requests.Load() != 1 {
		t.Fatalf("verified bridge did not reach authenticated RPC: %v, dials %d", err, requests.Load())
	}
	inactive := newRemoteProvider(testCore(t, nil), ProviderConfig{ID: "inactive", Address: "peer.example.ts.net:9418", Token: "must-not-cross-wire"})
	defer inactive.Close()
	ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := inactive.call(ctx, "status", map[string]any{}, nil); err == nil {
		t.Fatal("Tailnet hostname alone authorized plaintext transport")
	}
}

func TestRemoteAuthenticationRejectionRetainsSendAndReplyRetryIdentity(t *testing.T) {
	for _, method := range []string{"send", "automatic-send", "reply"} {
		t.Run(method, func(t *testing.T) {
			upstream := testCore(t, nil)
			bot := installFake(t, upstream, "bot")
			downstream := testCore(t, nil)
			session := Session{NodeID: downstream.node(), Adapter: "codex", SessionID: "auth-retry"}
			binding, err := upstream.Ensure(context.Background(), "bot", session)
			must(t, err)
			address, token := testServer(t, upstream)
			cfg := ProviderConfig{ID: "remote", Name: "Remote", Type: "remote", Address: address, Token: "wrong-token", Enabled: true}
			ref := MessageRef{OriginNodeID: upstream.node(), ProviderID: "bot", MessageID: "original"}
			must(t, downstream.store.Update(func(d *State) error {
				d.Providers[cfg.ID] = cfg
				d.DefaultProvider = cfg.ID
				d.Bindings[session.key()] = Binding{ProviderID: cfg.ID, Session: session, ChatID: binding.ChatID, ResourceNodeID: upstream.node(), ResourceProviderID: "bot"}
				remember(d, ref, cfg.ID)
				return nil
			}))
			bad := newRemoteProvider(downstream, cfg)
			defer bad.Close()
			installRoutingBot(downstream, cfg.ID, bad)
			request := "stable-request"
			if method == "automatic-send" {
				request = ""
			}
			invoke := func() (SendResult, error) {
				if method == "reply" {
					return downstream.Reply(context.Background(), ref, Content{Text: "retry once"}, request)
				}
				return downstream.Send(context.Background(), cfg.ID, session, Content{Text: "retry once"}, request)
			}
			_, err = invoke()
			if publicError(err).Code != "rejection_retryable" {
				t.Fatalf("bad token returned %v", err)
			}
			before := downstream.store.Snapshot().Operations
			if len(before) != 1 {
				t.Fatalf("rejection retained %d operations", len(before))
			}
			var operationKey, effectiveRequest string
			for key, op := range before {
				operationKey, effectiveRequest = key, op.RequestID
				if op.State != "retryable" || effectiveRequest == "" {
					t.Fatal("authentication failure made request uncertain or lost its identity")
				}
			}
			bot.mu.Lock()
			calls := bot.sends + bot.replies
			bot.mu.Unlock()
			if calls != 0 {
				t.Fatal("unauthenticated command reached provider dispatch")
			}
			cfg.Token = token
			good := newRemoteProvider(downstream, cfg)
			defer good.Close()
			installRoutingBot(downstream, cfg.ID, good)
			must(t, downstream.store.Update(func(d *State) error { d.Providers[cfg.ID] = cfg; return nil }))
			result, err := invoke()
			must(t, err)
			op := downstream.store.Snapshot().Operations[operationKey]
			if !result.Message.valid() || op.State != "complete" || op.RequestID != effectiveRequest {
				t.Fatal("corrected-token retry lost stable request/result identity")
			}
			if request != "" {
				again, err := invoke()
				must(t, err)
				if result.Message != again.Message {
					t.Fatal("retry repeated completed request")
				}
			}
			bot.mu.Lock()
			calls = bot.sends + bot.replies
			bot.mu.Unlock()
			if calls != 1 {
				t.Fatalf("corrected auth dispatched %d times", calls)
			}
		})
	}
}

func TestRemoteKnownSuccessSurvivesCommittedReferenceWarning(t *testing.T) {
	upstream := testCore(t, nil)
	bot := installFake(t, upstream, "bot")
	downstream := testCore(t, nil)
	session := Session{NodeID: downstream.node(), Adapter: "codex", SessionID: "known-success"}
	binding, err := upstream.Ensure(context.Background(), "bot", session)
	must(t, err)
	address, token := testServer(t, upstream)
	cfg := ProviderConfig{ID: "remote", Name: "Remote", Type: "remote", Address: address, Token: token, Enabled: true}
	must(t, downstream.store.Update(func(d *State) error {
		d.Providers[cfg.ID] = cfg
		d.Bindings[session.key()] = Binding{ProviderID: cfg.ID, Session: session, ChatID: binding.ChatID, ResourceNodeID: upstream.node(), ResourceProviderID: "bot"}
		return nil
	}))
	p := newRemoteProvider(downstream, cfg)
	defer p.Close()
	installRoutingBot(downstream, cfg.ID, p)
	downstream.store.mu.Lock()
	original := downstream.store.syncDirectory
	var syncs atomic.Int32
	var injected atomic.Bool
	downstream.store.syncDirectory = func(dir string) error {
		syncs.Add(1)
		// The store lock is held and its replacement has been published.
		// Target the first retained remote result, not an ordinal write:
		// retryable proof and pending admission both precede this boundary.
		if len(downstream.store.state.References) > 0 && injected.CompareAndSwap(false, true) {
			return errors.New("synthetic remember directory sync failure")
		}
		return original(dir)
	}
	downstream.store.mu.Unlock()
	result, err := downstream.Send(context.Background(), cfg.ID, session, Content{Text: "accepted"}, "known-result")
	downstream.store.mu.Lock()
	downstream.store.syncDirectory = original
	downstream.store.mu.Unlock()
	must(t, err)
	if !injected.Load() || syncs.Load() < 4 {
		t.Fatal("test did not exercise retryable proof, pending admission, remote remember, and root result persistence")
	}
	key := "send:" + session.key() + ":known-result"
	if op := downstream.store.Snapshot().Operations[key]; op.State != "complete" {
		t.Fatal("known upstream success was changed to uncertain outcome")
	}
	again, err := downstream.Send(context.Background(), cfg.ID, session, Content{Text: "accepted"}, "known-result")
	must(t, err)
	if result.Message != again.Message {
		t.Fatal("known-result retry changed message identity")
	}
	bot.mu.Lock()
	calls := bot.sends
	bot.mu.Unlock()
	if calls != 1 {
		t.Fatalf("committed reference warning repeated upstream send %d times", calls)
	}
}

type uncertainTransportServer struct {
	pb.UnimplementedNotificationCoreServer
	code codes.Code
}

func (s uncertainTransportServer) Call(context.Context, *pb.Command) (*pb.Result, error) {
	return nil, status.Error(s.code, "uncertain transport outcome")
}
func TestRemoteNonAuthenticationTransportErrorsRemainUncertain(t *testing.T) {
	for _, code := range []codes.Code{codes.Unavailable, codes.DeadlineExceeded, codes.PermissionDenied, codes.Internal} {
		t.Run(code.String(), func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			must(t, err)
			server := grpc.NewServer()
			pb.RegisterNotificationCoreServer(server, uncertainTransportServer{code: code})
			go func() { _ = server.Serve(listener) }()
			defer server.Stop()
			p := newRemoteProvider(testCore(t, nil), ProviderConfig{ID: "uncertain", Address: listener.Addr().String(), Token: "synthetic"})
			defer p.Close()
			err = p.call(context.Background(), "message.send", map[string]any{}, nil)
			if _, proven := rejectionState(err); proven {
				t.Fatalf("%v was promoted to non-submission proof", code)
			}
		})
	}
}

func TestRemoteConfirmationGenerationIsAtomicThroughPersistence(t *testing.T) {
	c := testCore(t, nil)
	_, _ = testServer(t, c)
	server := c.server
	sub, err := c.Subscribe(context.Background(), "generation-peer", "")
	must(t, err)
	defer sub.Close()
	must(t, c.Ingest(context.Background(), eventFor("elsewhere", "before-rotation"), ""))
	must(t, c.Ingest(context.Background(), eventFor("elsewhere", "after-rotation"), ""))
	// Deliberately omit AfterFunc. Generation checks must reject a stale RPC
	// even if asynchronous propagation of cancellation has not run yet.
	stale := context.WithValue(context.Background(), remoteAuthGenerationKey{}, server.authContext)
	r := c.store.Snapshot().Remote
	r.Token = "rotated-token"
	c.store.mu.Lock()
	storeLocked := true
	defer func() {
		if storeLocked {
			c.store.mu.Unlock()
		}
	}()
	confirmed := make(chan error, 1)
	go func() { confirmed <- server.confirmSubscription(stale, sub, "before-rotation") }()
	await(t, func() bool {
		if server.configMu.TryLock() {
			server.configMu.Unlock()
			return false
		}
		return true
	})
	rotated := make(chan error, 1)
	go func() {
		c.ops.Lock()
		defer c.ops.Unlock()
		rotated <- c.reconfigureRemote(r, func(d *State) error { d.Remote = r; return nil })
	}()
	// The confirmation is paused after generation validation, before the store
	// transaction. Rotation must wait for its RLock, not commit around it.
	select {
	case err := <-rotated:
		c.store.mu.Unlock()
		storeLocked = false
		t.Fatalf("rotation passed in-flight confirmation: %v", err)
	default:
	}
	c.store.mu.Unlock()
	storeLocked = false
	select {
	case err := <-confirmed:
		must(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("confirmation/rotation deadlocked")
	}
	select {
	case err := <-rotated:
		must(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("rotation/confirmation deadlocked")
	}
	if stale.Err() != nil {
		t.Fatal("test did not isolate asynchronous cancellation scheduling")
	}
	before := c.store.Snapshot().Peers["generation-peer"]
	if !reflect.DeepEqual(before.Pending, []string{"after-rotation"}) {
		t.Fatalf("unexpected pre-rotation confirmation state: %v", before.Pending)
	}
	err = server.confirmSubscription(stale, sub, "after-rotation")
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("revoked generation confirmed after rotation: %v", err)
	}
	if !reflect.DeepEqual(before, c.store.Snapshot().Peers["generation-peer"]) {
		t.Fatal("revoked generation changed durable backlog")
	}
}

type inboxReleaseProbe struct {
	pb.UnimplementedNotificationCoreServer
	commands chan *pb.Command
}

func (s inboxReleaseProbe) Call(_ context.Context, in *pb.Command) (*pb.Result, error) {
	s.commands <- in
	return &pb.Result{ResultJson: []byte(`{"released":true}`)}, nil
}
func TestRemoteInboxReleasePreservesReferenceAndRoute(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	probe := inboxReleaseProbe{commands: make(chan *pb.Command, 1)}
	server := grpc.NewServer()
	pb.RegisterNotificationCoreServer(server, probe)
	go func() { _ = server.Serve(listener) }()
	defer server.Stop()
	c := testCore(t, nil)
	p := newRemoteProvider(c, ProviderConfig{ID: "release", Address: listener.Addr().String(), Token: "synthetic"})
	defer p.Close()
	ref := MessageRef{OriginNodeID: "origin", ProviderID: "bot", MessageID: "queued", ThreadID: "thread"}
	must(t, p.ReleaseInbox(context.Background(), ref))
	command := <-probe.commands
	var params struct {
		Message MessageRef `json:"message"`
	}
	must(t, json.Unmarshal(command.ParamsJson, &params))
	if command.Method != "message.inbox.release" || params.Message != ref || !reflect.DeepEqual(command.VisitedNodes, []string{c.node()}) {
		t.Fatal("release changed message identity or command route")
	}
}

type inboxStatusProbe struct {
	pb.UnimplementedNotificationCoreServer
	commands chan *pb.Command
	result   []byte
	code     codes.Code
}

func (s inboxStatusProbe) Call(_ context.Context, in *pb.Command) (*pb.Result, error) {
	s.commands <- in
	if s.code != codes.OK {
		return nil, status.Error(s.code, "synthetic status failure")
	}
	return &pb.Result{ResultJson: s.result}, nil
}
func TestRemoteInboxStatusPreservesReferenceAndFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name             string
		result           string
		code             codes.Code
		consumed, failed bool
	}{
		{name: "pending", result: `{"consumed":false}`},
		{name: "consumed", result: `{"consumed":true}`, consumed: true},
		{name: "missing", result: `{}`},
		{name: "malformed", result: `{"consumed":true,"other":`, failed: true},
		{name: "transport", code: codes.Unavailable, failed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			must(t, err)
			probe := inboxStatusProbe{commands: make(chan *pb.Command, 1), result: []byte(tc.result), code: tc.code}
			server := grpc.NewServer()
			pb.RegisterNotificationCoreServer(server, probe)
			go func() { _ = server.Serve(listener) }()
			defer server.Stop()
			c := testCore(t, nil)
			p := newRemoteProvider(c, ProviderConfig{ID: "status", Address: listener.Addr().String(), Token: "synthetic"})
			defer p.Close()
			ref := MessageRef{OriginNodeID: "origin", ProviderID: "bot", MessageID: "queued", ThreadID: "thread"}
			consumed, err := p.InboxConsumed(context.Background(), ref)
			if consumed != tc.consumed || (err != nil) != tc.failed {
				t.Fatalf("consumption = %v, error %v", consumed, err)
			}
			command := <-probe.commands
			var params struct {
				Message MessageRef `json:"message"`
			}
			must(t, json.Unmarshal(command.ParamsJson, &params))
			if command.Method != "message.inbox.status" || params.Message != ref || !reflect.DeepEqual(command.VisitedNodes, []string{c.node()}) {
				t.Fatal("status changed message identity or command route")
			}
		})
	}
}

func TestRemoteInboxReleaseSkipsOnlyActualCycles(t *testing.T) {
	upstream := testCore(t, nil)
	address, token := testServer(t, upstream)
	downstream := testCore(t, nil)
	p := newRemoteProvider(downstream, ProviderConfig{ID: "release", Address: address, Token: token})
	defer p.Close()
	ref := MessageRef{OriginNodeID: "origin", ProviderID: "bot", MessageID: "queued"}
	cycle := context.WithValue(context.Background(), commandRouteKey{}, []string{upstream.node()})
	before := upstream.store.Snapshot()
	must(t, p.ReleaseInbox(cycle, ref))
	if !reflect.DeepEqual(before, upstream.store.Snapshot()) {
		t.Fatal("cyclic release repeated a local mutation")
	}
	if err := p.Ack(cycle, ref); err == nil {
		t.Fatal("business acknowledgment incorrectly skipped a routing cycle")
	}
	if consumed, err := p.InboxConsumed(cycle, ref); err == nil || consumed {
		t.Fatal("cyclic status was mistaken for proof of consumption")
	}
	longRoute := make([]string, 16)
	for i := range longRoute {
		longRoute[i] = "unvisited-hop"
	}
	exhausted := context.WithValue(context.Background(), commandRouteKey{}, longRoute)
	if err := p.ReleaseInbox(exhausted, ref); err == nil {
		t.Fatal("release hop exhaustion was marked complete")
	}
	if consumed, err := p.InboxConsumed(exhausted, ref); err == nil || consumed {
		t.Fatal("status hop exhaustion was mistaken for proof of consumption")
	}
}

func TestRemoteCommittedConfigurationWarningStillReconcilesRevocation(t *testing.T) {
	c := testCore(t, nil)
	address, token := testServer(t, c)
	server := c.server
	stale := context.WithValue(context.Background(), remoteAuthGenerationKey{}, server.authContext)
	c.store.mu.Lock()
	original := c.store.syncDirectory
	c.store.syncDirectory = func(string) error { return errors.New("synthetic directory sync failure") }
	c.store.mu.Unlock()
	raw, err := json.Marshal(map[string]string{"token": "committed-new-token"})
	must(t, err)
	_, err = c.ConfigureRemote(raw)
	c.store.mu.Lock()
	c.store.syncDirectory = original
	c.store.mu.Unlock()
	if err == nil || !stateCommitted(err) {
		t.Fatalf("expected committed-not-durable warning, got %v", err)
	}
	if c.server != server || c.store.Snapshot().Remote.Token != "committed-new-token" {
		t.Fatal("committed config was rolled back at runtime")
	}
	if err := server.withAuthGeneration(stale, func() error { t.Fatal("revoked generation was admitted"); return nil }); status.Code(err) != codes.Unauthenticated {
		t.Fatal("committed rotation failed to revoke old generation")
	}
	if status.Code(probeListener(t, address, token, nil)) != codes.Unauthenticated {
		t.Fatal("old token survived committed-warning rotation")
	}
	must(t, probeListener(t, address, "committed-new-token", nil))
}
