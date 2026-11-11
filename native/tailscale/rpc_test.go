package tailscale

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

type fakeClient struct {
	status func(context.Context) (*ipnstate.Status, error)
	login  func(context.Context) error
	logout func(context.Context) error
	whois  func(context.Context, string) (*apitype.WhoIsResponse, error)
}

func (f fakeClient) StatusWithoutPeers(ctx context.Context) (*ipnstate.Status, error) {
	if f.status != nil {
		return f.status(ctx)
	}
	return &ipnstate.Status{BackendState: "NeedsLogin"}, nil
}
func (f fakeClient) StartLoginInteractive(ctx context.Context) error {
	if f.login != nil {
		return f.login(ctx)
	}
	return nil
}
func (f fakeClient) Logout(ctx context.Context) error {
	if f.logout != nil {
		return f.logout(ctx)
	}
	return nil
}
func (f fakeClient) WhoIs(ctx context.Context, ip string) (*apitype.WhoIsResponse, error) {
	if f.whois != nil {
		return f.whois(ctx, ip)
	}
	return nil, local.ErrPeerNotFound
}

func newDispatcher(client localClient) *rpcDispatcher {
	return &rpcDispatcher{client: client, listening: func() bool { return true }, mutations: make(chan struct{}, 1)}
}

func TestDecodeRequest(t *testing.T) {
	for _, line := range []string{
		`{"id":1,"method":"status"}`,
		` {"method":"whois", "ip":"100.64.0.2", "id":2} `,
		`{"id":9007199254740991,"method":"logout"}`,
		`{"id":1,"method":"tunnel","address":"peer.tail.ts.net:7443"}`,
		`{"id":2,"method":"close_tunnel","tunnel_id":"1"}`,
		`{"id":3,"method":"publish","port":7443,"target":"127.0.0.1:12345"}`,
		`{"id":4,"method":"unpublish","port":7443}`,
	} {
		if _, code := decodeRequest([]byte(line)); code != "" {
			t.Errorf("rejected %s: %s", line, code)
		}
	}
	for _, line := range []string{
		``, `null`, `[]`, `1`, `{}`, `{"id":1}`, `{"method":"login"}`,
		`{"id":null,"method":"login"}`, `{"id":"1","method":"status"}`,
		`{"id":1.5,"method":"status"}`, `{"id":-1,"method":"status"}`, `{"id":0,"method":"status"}`,
		`{"id":9007199254740992,"method":"status"}`, `{"id":1,"method":null}`,
		`{"id":1,"method":"status","extra":"x"}`,
		`{"id":1,"method":"status","address":"100.64.0.2:80"}`,
		`{"id":1,"method":"tunnel","target":"127.0.0.1:80"}`,
		`{"id":1,"method":"publish","port":"7443","target":"127.0.0.1:80"}`,
		`{"id":1,"method":"publish","port":1.5,"target":"127.0.0.1:80"}`,
		`{"id":1,"method":"publish","port":7443,"port":7444}`,
		`{"id":1,"method":"unpublish","port":7443,"target":"127.0.0.1:80"}`,
		`{"id":1,"method":"close_tunnel","tunnel_id":2}`,
		`{"id":1,"method":"tunnel","address":"100.64.0.2:80","tunnel_id":"1"}`,
		`{"id":1,"method":"status","ip":"100.64.0.2"}`,
		`{"id":1,"method":"status","method":"login"}`,
		`{"id":1,"id":2,"method":"login"}`,
		`{"id":1,"method":"status"} {"id":2,"method":"logout"}`,
		`{"id":1,"method":"login"`,
	} {
		if _, code := decodeRequest([]byte(line)); code != "invalid_request" {
			t.Errorf("accepted %q: %s", line, code)
		}
	}
}

func TestStatusKeepsAuthURLAndOwnerOnly(t *testing.T) {
	status := &ipnstate.Status{
		BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/private-test-token",
		Self: &ipnstate.PeerStatus{HostName: "nootify", DNSName: "nootify.example.ts.net.", UserID: 7,
			TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.1")}, Addrs: []string{"192.168.0.1:1234"}},
		User: map[tailcfg.UserID]tailcfg.UserProfile{7: {ID: 7, LoginName: "owner@example.com"}, 8: {ID: 8, LoginName: "other@example.com"}},
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{{}: {HostName: "must-not-be-in-status"}},
	}
	d := newDispatcher(fakeClient{status: func(context.Context) (*ipnstate.Status, error) { return status, nil }})
	for _, listening := range []bool{false, true} {
		d.listening = func() bool { return listening }
		reply := d.dispatch(context.Background(), request{ID: 42, Method: "status"})
		data := encodeResponse(reply)
		var decoded struct {
			ID     int64        `json:"id"`
			Result statusResult `json:"result"`
		}
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.ID != 42 || decoded.Result.AuthURL != status.AuthURL || decoded.Result.NootifyListening != listening {
			t.Fatalf("incorrect status %s", data)
		}
		if len(decoded.Result.User) != 1 || decoded.Result.User[7].LoginName != "owner@example.com" || decoded.Result.Self.DNSName != status.Self.DNSName {
			t.Fatalf("incorrect owner/self %s", data)
		}
		for _, forbidden := range []string{"must-not-be-in-status", "other@example.com", "192.168.0.1", `"Peer"`, `"Addrs"`} {
			if strings.Contains(string(data), forbidden) {
				t.Errorf("status leaked %s", forbidden)
			}
		}
	}
}

func TestDispatchLoginLogoutAndWhoIs(t *testing.T) {
	var login, logout int
	var gotIP string
	identity := &apitype.WhoIsResponse{
		Node:        &tailcfg.Node{User: 7},
		UserProfile: &tailcfg.UserProfile{ID: 7, LoginName: "owner@example.com"},
	}
	d := newDispatcher(fakeClient{
		login:  func(context.Context) error { login++; return nil },
		logout: func(context.Context) error { logout++; return nil },
		whois:  func(_ context.Context, ip string) (*apitype.WhoIsResponse, error) { gotIP = ip; return identity, nil },
	})
	for _, method := range []string{"login", "logout"} {
		reply := d.dispatch(context.Background(), request{ID: 1, Method: method})
		if reply.Error != "" || !strings.Contains(string(encodeResponse(reply)), `"ok":true`) {
			t.Fatalf("%s: %#v", method, reply)
		}
	}
	if login != 1 || logout != 1 {
		t.Fatalf("auth calls: login=%d logout=%d", login, logout)
	}
	for input, want := range map[string]string{
		"100.64.0.2": "100.64.0.2", "::ffff:100.64.0.2": "100.64.0.2", "fd7a:115c:a1e0::2": "fd7a:115c:a1e0::2",
	} {
		reply := d.dispatch(context.Background(), request{ID: 2, Method: "whois", IP: input})
		if reply.Error != "" || reply.Result != identity || gotIP != want {
			t.Fatalf("whois %q = %#v, called %q", input, reply, gotIP)
		}
	}
	for _, input := range []string{"", "localhost", "100.64.0.2:80", "[fd7a:115c:a1e0::2]", "fe80::1%en0", "100.64.0.2\r\n", "0.0.0.0", "::", "224.0.0.1", "127.0.0.1"} {
		gotIP = ""
		reply := d.dispatch(context.Background(), request{ID: 3, Method: "whois", IP: input})
		if reply.Error != "invalid_ip" || gotIP != "" {
			t.Fatalf("unsafe whois %q: %#v, called %q", input, reply, gotIP)
		}
	}
	if got := d.dispatch(context.Background(), request{ID: 4, Method: "serve"}); got.Error != "unknown_method" {
		t.Fatal(got)
	}
}

func TestWhoIsRejectsTaggedPeersBeforeReturningUserProfile(t *testing.T) {
	for _, profile := range []*tailcfg.UserProfile{nil, {ID: 7, LoginName: "owner@example.com"}} {
		identity := &apitype.WhoIsResponse{
			Node: &tailcfg.Node{User: 7, Tags: []string{"tag:server"}}, UserProfile: profile,
		}
		if !identity.Node.IsTagged() {
			t.Fatal("test fixture must be a real tagged tailcfg.Node")
		}
		d := newDispatcher(fakeClient{whois: func(context.Context, string) (*apitype.WhoIsResponse, error) { return identity, nil }})
		reply := d.dispatch(context.Background(), request{ID: 7, Method: "whois", IP: "100.64.0.2"})
		if reply.ID != 7 || reply.Error != "peer_not_found" || reply.Result != nil {
			t.Fatalf("tagged peer admitted: %#v", reply)
		}
		if data := string(encodeResponse(reply)); strings.Contains(data, "owner@example.com") || strings.Contains(data, "tag:server") {
			t.Fatalf("tagged peer identity escaped: %s", data)
		}
	}
}

func TestRPCErrorRedactionAndTimeout(t *testing.T) {
	secret := errors.New("backend: https://login.tailscale.com/a/must-not-escape")
	d := newDispatcher(fakeClient{
		status: func(context.Context) (*ipnstate.Status, error) { return nil, secret },
		login:  func(context.Context) error { return secret },
		logout: func(context.Context) error { return secret },
		whois:  func(context.Context, string) (*apitype.WhoIsResponse, error) { return nil, secret },
	})
	for _, method := range []string{"status", "login", "logout", "whois"} {
		reply := d.dispatch(context.Background(), request{ID: 1, Method: method, IP: "100.64.0.2"})
		if reply.Error != method+"_failed" || strings.Contains(string(encodeResponse(reply)), "must-not-escape") {
			t.Fatalf("unsafe %s error: %#v", method, reply)
		}
	}
	d.client = fakeClient{status: func(ctx context.Context) (*ipnstate.Status, error) { <-ctx.Done(); return nil, ctx.Err() }}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if got := d.dispatch(ctx, request{ID: 5, Method: "status"}); got.Error != "timeout" {
		t.Fatal(got)
	}
	d.client = fakeClient{}
	if got := d.dispatch(context.Background(), request{ID: 6, Method: "whois", IP: "100.64.0.2"}); got.Error != "peer_not_found" {
		t.Fatal(got)
	}
}

func TestAuthMutationsRespectCancellationWhileQueued(t *testing.T) {
	entered := make(chan struct{})
	finished := make(chan response, 1)
	d := newDispatcher(fakeClient{login: func(ctx context.Context) error { close(entered); <-ctx.Done(); return ctx.Err() }})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { finished <- d.dispatch(ctx, request{ID: 1, Method: "login"}) }()
	await(t, entered)
	queued, stop := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer stop()
	if got := d.dispatch(queued, request{ID: 2, Method: "logout"}); got.Error != "timeout" {
		t.Fatal(got)
	}
	cancel()
	select {
	case got := <-finished:
		if got.Error != "canceled" {
			t.Fatal(got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("login leaked")
	}
}

func TestResponseBoundAndSafeEncodingErrors(t *testing.T) {
	for _, test := range []struct {
		result any
		code   string
	}{
		{strings.Repeat("x", maxResponseBytes), "response_too_large"},
		{make(chan int), "encoding_failed"},
	} {
		data := encodeResponse(response{ID: 17, Result: test.result})
		var reply response
		if err := json.Unmarshal(data, &reply); err != nil {
			t.Fatal(err)
		}
		if len(data) > maxResponseBytes || reply.ID != 17 || reply.Error != test.code || data[len(data)-1] != '\n' {
			t.Fatalf("bad bounded reply: %s", data)
		}
	}
}

func await(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for goroutine to exit")
	}
}

type rpcHarness struct {
	input  *io.PipeWriter
	output *bufio.Reader
	reader *io.PipeReader
	cancel context.CancelFunc
	done   chan struct{}
	err    error
}

func startRPC(t *testing.T, handler func(context.Context, request) response) *rpcHarness {
	t.Helper()
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	h := &rpcHarness{input: writer, output: bufio.NewReader(reader), reader: reader, cancel: cancel, done: make(chan struct{})}
	go func() { h.err = serveRPC(ctx, input, &protocolOutput{WriteCloser: output}, handler); close(h.done) }()
	t.Cleanup(func() { cancel(); writer.Close(); reader.Close(); await(t, h.done) })
	return h
}

func (h *rpcHarness) send(t *testing.T, data string) {
	t.Helper()
	if _, err := io.WriteString(h.input, data); err != nil {
		t.Fatal(err)
	}
}
func (h *rpcHarness) read(t *testing.T) response {
	t.Helper()
	type answer struct {
		reply response
		err   error
	}
	result := make(chan answer, 1)
	go func() {
		line, err := h.output.ReadBytes('\n')
		var reply response
		if err == nil {
			err = json.Unmarshal(line, &reply)
		}
		result <- answer{reply, err}
	}()
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatal(got.err)
		}
		return got.reply
	case <-time.After(3 * time.Second):
		h.cancel()
		t.Fatal("reply timed out")
		return response{}
	}
}

func TestRPCFramingAndMalformedLines(t *testing.T) {
	var calls atomic.Int32
	h := startRPC(t, func(ctx context.Context, req request) response {
		calls.Add(1)
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > rpcTimeout {
			return failure(req.ID, "missing_timeout")
		}
		return response{ID: req.ID, Result: true}
	})
	h.send(t, `{"id":1,"meth`)
	if calls.Load() != 0 {
		t.Fatal("dispatched an incomplete line")
	}
	h.send(t, "od\":\"status\"}\r\n")
	if got := h.read(t); got.ID != 1 || got.Error != "" {
		t.Fatal(got)
	}
	h.send(t, "not json\n")
	if got := h.read(t); got.ID != 0 || got.Error != "invalid_request" {
		t.Fatal(got)
	}
	h.send(t, strings.Repeat("x", maxRequestBytes+50)+"\n")
	if got := h.read(t); got.Error != "request_too_large" {
		t.Fatal(got)
	}
	h.send(t, "{\"id\":2,\"method\":\"status\"}\n{\"id\":3,\"method\":\"status\"}\n")
	seen := make(map[int64]bool)
	for range 2 {
		got := h.read(t)
		if got.Error != "" {
			t.Fatal(got)
		}
		seen[got.ID] = true
	}
	if !seen[2] || !seen[3] || calls.Load() != 3 {
		t.Fatalf("bad framing: %v / %d", seen, calls.Load())
	}
	// An EOF fragment is not a command and cannot initiate login.
	h.send(t, `{"id":4,"method":"login"}`)
	h.input.Close()
	await(t, h.done)
	if calls.Load() != 3 || h.err != nil {
		t.Fatalf("EOF behavior: calls=%d err=%v", calls.Load(), h.err)
	}
}

func TestRPCConcurrencyBoundAndEOFCancellation(t *testing.T) {
	entered := make(chan struct{}, maxRPCConcurrent)
	var active atomic.Int32
	h := startRPC(t, func(ctx context.Context, req request) response {
		active.Add(1)
		defer active.Add(-1)
		entered <- struct{}{}
		<-ctx.Done()
		return failure(req.ID, "canceled")
	})
	for i := range maxRPCConcurrent {
		h.send(t, fmt.Sprintf("{\"id\":%d,\"method\":\"status\"}\n", i+1))
		await(t, entered)
	}
	h.send(t, "{\"id\":99,\"method\":\"status\"}\n")
	if got := h.read(t); got.ID != 99 || got.Error != "busy" {
		t.Fatal(got)
	}
	if active.Load() != maxRPCConcurrent {
		t.Fatalf("active calls = %d", active.Load())
	}
	h.input.Close()
	await(t, h.done)
	if active.Load() != 0 || h.err != nil {
		t.Fatalf("EOF did not release calls: %d, %v", active.Load(), h.err)
	}
}

type fragmentedOutput struct{ bytes.Buffer }

func (o *fragmentedOutput) Write(data []byte) (int, error) {
	for _, b := range data {
		o.WriteByte(b)
		runtime.Gosched()
	}
	return len(data), nil
}
func (*fragmentedOutput) Close() error { return nil }

func TestProtocolSerializesLifecycleAndRPCFrames(t *testing.T) {
	var stream fragmentedOutput
	output := &protocolOutput{WriteCloser: &stream}
	var workers sync.WaitGroup
	errors := make(chan error, 65)
	// A yielding, byte-at-a-time sink makes any unsynchronized writes interleave.
	for id := range int64(65) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			reply := response{ID: id, Result: strings.Repeat("payload", 32)}
			if id == 0 {
				reply = failure(0, "listener_failed")
			}
			errors <- output.emit(reply)
		}()
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	reader := bufio.NewReader(&stream)
	seen := make(map[int64]bool)
	for range 65 {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var reply response
		if err := json.Unmarshal(line, &reply); err != nil {
			t.Fatalf("interleaved protocol frame: %v", err)
		}
		if seen[reply.ID] || reply.ID < 0 || reply.ID > 64 {
			t.Fatalf("invalid/duplicate frame: %#v", reply)
		}
		seen[reply.ID] = true
		if reply.ID == 0 && reply.Error != "listener_failed" {
			t.Fatalf("lost lifecycle error: %#v", reply)
		}
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("extra protocol bytes: %v", err)
	}
}

func TestRPCCancellationUnblocksOutput(t *testing.T) {
	returned := make(chan struct{})
	h := startRPC(t, func(_ context.Context, req request) response {
		close(returned)
		return response{ID: req.ID, Result: true}
	})
	h.send(t, "{\"id\":1,\"method\":\"status\"}\n")
	await(t, returned)
	// Do not read stdout. Cancellation must release its blocked writer too.
	h.cancel()
	await(t, h.done)
	if h.err != nil {
		t.Fatal(h.err)
	}
}
