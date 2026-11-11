package tailscale

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

func startLibraryService(t *testing.T, node *fakeNode) *Service {
	t.Helper()
	if node.client == nil {
		node.client = fakeClient{}
	}
	if node.listener == nil && node.listen == nil {
		node.listener = newTestListener()
	}
	s := newService(config{stateDir: filepath.Join(t.TempDir(), "state")}, node)
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestLibraryConfigAndClosedLifecycle(t *testing.T) {
	for _, cfg := range []Config{
		{StateDir: "relative", Target: "tcp://127.0.0.1:1234"},
		{StateDir: filepath.Join(t.TempDir(), "state"), Target: "tcp://localhost:1234"},
		{StateDir: filepath.Join(t.TempDir(), "state"), Target: "tcp://192.0.2.1:1234"},
		{StateDir: filepath.Join(t.TempDir(), "state"), Target: "tcp://127.0.0.1:1234", Hostname: "bad hostname"},
	} {
		if _, err := NewService(cfg); err == nil {
			t.Fatalf("accepted unsafe embedded configuration: %#v", cfg)
		}
	}
	s, err := NewService(Config{StateDir: filepath.Join(t.TempDir(), "state"), Target: "tcp://127.0.0.1:1234"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	await(t, s.Done())
	if err := s.Start(context.Background()); err == nil || err.Error() != "unavailable" {
		t.Fatalf("closed service restarted: %v", err)
	}
	if _, err := s.Status(context.Background()); err == nil {
		t.Fatal("closed service accepted a call")
	}
}

func TestLibraryMethodsReuseSanitizedDispatcherAndTaggedNodeGuard(t *testing.T) {
	var logins, logouts atomic.Int32
	node := &fakeNode{client: fakeClient{
		status: func(context.Context) (*ipnstate.Status, error) {
			return &ipnstate.Status{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/private"}, nil
		},
		login:  func(context.Context) error { logins.Add(1); return nil },
		logout: func(context.Context) error { logouts.Add(1); return errors.New("secret") },
		whois: func(context.Context, string) (*apitype.WhoIsResponse, error) {
			return &apitype.WhoIsResponse{Node: &tailcfg.Node{Tags: []string{"tag:server"}}, UserProfile: &tailcfg.UserProfile{LoginName: "owner@example.com"}}, nil
		},
	}}
	s := startLibraryService(t, node)
	status, err := s.Status(context.Background())
	if err != nil || status.BackendState != "NeedsLogin" || !strings.HasSuffix(status.AuthURL, "/private") {
		t.Fatalf("incorrect direct status: %#v %v", status, err)
	}
	if err := s.Login(context.Background()); err != nil || logins.Load() != 1 {
		t.Fatalf("interactive login: %v", err)
	}
	if err := s.Logout(context.Background()); err == nil || err.Error() != "logout_failed" || logouts.Load() != 1 {
		t.Fatalf("unsafe logout error: %v", err)
	}
	if identity, err := s.WhoIs(context.Background(), "100.64.0.2"); identity != nil || err == nil || err.Error() != "peer_not_found" {
		t.Fatalf("tagged device admitted as a user: %#v %v", identity, err)
	}
}

func TestLibraryCloseWaitsForStartAndHoldsStateLock(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	releaseStart := sync.OnceFunc(func() { close(release) })
	t.Cleanup(releaseStart)
	path := filepath.Join(t.TempDir(), "state")
	node := &fakeNode{start: func() error { close(entered); <-release; return nil }}
	s := newService(config{stateDir: path}, node)
	startDone, closeDone := make(chan struct{}), make(chan struct{})
	go func() { _ = s.Start(context.Background()); close(startDone) }()
	await(t, entered)
	if lock, err := prepareStateDir(path); !errors.Is(err, errStateLocked) {
		if lock != nil {
			_ = lock.Close()
		}
		t.Fatalf("state was not locked during Start: %v", err)
	}
	go func() { _ = s.Close(); close(closeDone) }()
	select {
	case <-closeDone:
		t.Fatal("Close returned during Start")
	case <-time.After(10 * time.Millisecond):
	}
	if node.closed.Load() != 0 {
		t.Fatal("node closed concurrently with Start")
	}
	releaseStart()
	await(t, startDone)
	await(t, closeDone)
	if node.closed.Load() != 1 || node.clientCalls.Load() != 0 {
		t.Fatal("canceled startup continued or leaked node")
	}
	lock, err := prepareStateDir(path)
	if err != nil {
		t.Fatalf("shutdown retained state lock: %v", err)
	}
	_ = lock.Close()
}

func TestLibraryDirectDialUsesBoundedEncryptedStackAndClosesOnShutdown(t *testing.T) {
	var dials atomic.Int32
	var peers []net.Conn
	node := &fakeNode{dial: func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "peer.example.ts.net:7443" {
			t.Errorf("incorrect direct dial: %s %s", network, address)
		}
		dials.Add(1)
		client, peer := net.Pipe()
		peers = append(peers, peer)
		t.Cleanup(func() { _ = peer.Close() })
		return client, nil
	}}
	s := startLibraryService(t, node)
	for _, address := range []string{"127.0.0.1:7443", "192.0.2.1:7443", "10.0.0.1:7443", "100.100.100.100:7443", "localhost:7443"} {
		if conn, err := s.Dial(context.Background(), "tcp", address); conn != nil || err == nil {
			t.Fatalf("unsafe destination reached embedded stack: %s %v", address, err)
		}
	}
	if dials.Load() != 0 {
		t.Fatal("invalid address reached node.Dial")
	}
	var conns []net.Conn
	for range maxTunnels {
		conn, err := s.Dial(context.Background(), "tcp", "PEER.example.ts.net.:7443")
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, conn)
	}
	if conn, err := s.Dial(context.Background(), "tcp", "peer.example.ts.net:7443"); conn != nil || err == nil || err.Error() != "tunnel_limit" {
		t.Fatalf("direct sockets bypassed tunnel budget: %v %v", conn, err)
	}
	_ = conns[0].Close()
	if conn, err := s.Dial(context.Background(), "tcp", "peer.example.ts.net:7443"); conn == nil || err != nil {
		t.Fatalf("closed direct socket retained allocation: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for _, peer := range peers {
		_ = peer.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := peer.Read(make([]byte, 1)); err != io.EOF {
			t.Fatalf("direct connection survived shutdown: %v", err)
		}
	}
	if node.closed.Load() != 1 {
		t.Fatal("node was not closed exactly once")
	}
}

func TestLibraryShutdownCancelsPendingDirectCalls(t *testing.T) {
	entered := make(chan struct{})
	node := &fakeNode{dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		close(entered)
		<-ctx.Done()
		return nil, errors.New("upstream secret")
	}}
	s := startLibraryService(t, node)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := s.Dial(context.Background(), "tcp", "100.64.0.2:7443")
		if conn != nil || err == nil || strings.Contains(err.Error(), "secret") {
			t.Errorf("unsafe or successful canceled dial: %v %v", conn, err)
		}
	}()
	await(t, entered)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	await(t, done)
}

func TestLibraryRawListenerOwnsAcceptedSocketsAndSharesPublicationBudget(t *testing.T) {
	raw := newTestListener()
	node := &fakeNode{listenPort: func(int) (net.Listener, error) { return raw, nil }}
	s := startLibraryService(t, node)
	listener, err := s.Listen(7443)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Publish(context.Background(), 7443, "127.0.0.1:4321"); err == nil || err.Error() != "port_in_use" {
		t.Fatalf("direct and bridged listeners used the same port: %v", err)
	}
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			t.Errorf("direct accept: %v", err)
		}
		accepted <- conn
	}()
	await(t, raw.accepting)
	client, server := net.Pipe()
	defer client.Close()
	sendPeer(t, raw, server)
	conn := <-accepted
	if conn == nil {
		t.Fatal("listener failed to return accepted socket")
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := client.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("closed listener retained raw connection: %v", err)
	}
	if _, err := listener.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("closed direct listener accepted a socket: %v", err)
	}
}

func TestLibraryHTTPRoutingPreservesAcceptedPeerIdentity(t *testing.T) {
	backend := backendListener(t)
	listener := newTestListener()
	s := newService(config{stateDir: filepath.Join(t.TempDir(), "state"), target: backend.Addr().String()}, &fakeNode{client: fakeClient{}, listener: listener})
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	client, peer := tcpPair(t)
	sendPeer(t, listener, peer)
	server := acceptBackend(t, backend)
	reader := bufio.NewReader(server)
	header, err := reader.ReadString('\n')
	if err != nil || header != "PROXY TCP4 100.64.0.2 100.64.0.1 54321 80\r\n" {
		t.Fatalf("direct service lost authenticated transport identity: %q %v", header, err)
	}
	if _, err := io.WriteString(client, "GET /health HTTP/1.1\r\n"); err != nil {
		t.Fatal(err)
	}
	line, err := reader.ReadString('\n')
	if err != nil || line != "GET /health HTTP/1.1\r\n" {
		t.Fatalf("HTTP request was not routed to fixed backend: %q %v", line, err)
	}
}

func TestLibraryRuntimeHTTPFailureStopsNode(t *testing.T) {
	listener := newTestListener()
	node := &fakeNode{listener: listener}
	s := startLibraryService(t, node)
	await(t, listener.accepting)
	_ = listener.Close()
	await(t, s.Done())
	if s.Err() == nil || s.Err().Error() != "listener_failed" || node.closed.Load() != 1 {
		t.Fatalf("runtime listener failure lost: %v close=%d", s.Err(), node.closed.Load())
	}
}
