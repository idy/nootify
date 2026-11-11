package tailscale

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func tcpAddr(ip string, port int) *net.TCPAddr { return &net.TCPAddr{IP: net.ParseIP(ip), Port: port} }

type textAddr string

func (textAddr) Network() string  { return "tcp" }
func (a textAddr) String() string { return string(a) }

func TestProxyHeader(t *testing.T) {
	for _, test := range []struct {
		name          string
		remote, local net.Addr
		want          string
	}{
		{"ipv4", tcpAddr("100.64.0.2", 54321), tcpAddr("100.64.0.1", 80), "PROXY TCP4 100.64.0.2 100.64.0.1 54321 80\r\n"},
		{"ipv6", tcpAddr("fd7a:115c:a1e0::2", 54321), tcpAddr("fd7a:115c:a1e0::1", 80), "PROXY TCP6 fd7a:115c:a1e0::2 fd7a:115c:a1e0::1 54321 80\r\n"},
		{"mapped-ipv4", tcpAddr("::ffff:100.64.0.2", 54321), tcpAddr("100.64.0.1", 80), "PROXY TCP4 100.64.0.2 100.64.0.1 54321 80\r\n"},
		{"long-ipv6", tcpAddr("2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", 65535), tcpAddr("2001:db8:1111:2222:3333:4444:5555:6666", 65535), "PROXY TCP6 2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff 2001:db8:1111:2222:3333:4444:5555:6666 65535 65535\r\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := proxyHeader(test.remote, test.local)
			if err != nil || got != test.want || len(got) > maxProxyHeaderBytes {
				t.Fatalf("header = %q, %v", got, err)
			}
		})
	}
	for _, remote := range []net.Addr{
		nil, (*net.TCPAddr)(nil), textAddr("100.64.0.2:1234\r\nPROXY TCP4 attacker"),
		&net.UDPAddr{IP: net.ParseIP("100.64.0.2"), Port: 1234},
		tcpAddr("100.64.0.2", 0), tcpAddr("100.64.0.2", -1), tcpAddr("100.64.0.2", 65536),
		tcpAddr("invalid", 1234), tcpAddr("0.0.0.0", 1234), tcpAddr("224.0.0.1", 1234),
		&net.TCPAddr{IP: net.ParseIP("fd7a:115c:a1e0::2"), Port: 1234, Zone: "en0"},
		tcpAddr("fd7a:115c:a1e0::2", 1234), // mismatched address family
	} {
		if got, err := proxyHeader(remote, tcpAddr("100.64.0.1", 80)); err == nil || got != "" {
			t.Errorf("accepted unsafe source %v: %q, %v", remote, got, err)
		}
	}
	if _, err := proxyHeader(tcpAddr("100.64.0.2", 1234), textAddr("bad destination")); err == nil {
		t.Fatal("accepted invalid destination")
	}
}

type testListener struct {
	incoming   chan net.Conn
	fail       chan error
	closed     chan struct{}
	accepting  chan struct{}
	closeOnce  sync.Once
	acceptOnce sync.Once
}

func newTestListener() *testListener {
	return &testListener{incoming: make(chan net.Conn), fail: make(chan error, 1), closed: make(chan struct{}), accepting: make(chan struct{})}
}
func (l *testListener) Accept() (net.Conn, error) {
	l.acceptOnce.Do(func() { close(l.accepting) })
	select {
	case conn := <-l.incoming:
		return conn, nil
	case err := <-l.fail:
		return nil, err
	case <-l.closed:
		return nil, net.ErrClosed
	}
}
func (l *testListener) Close() error   { l.closeOnce.Do(func() { close(l.closed) }); return nil }
func (l *testListener) Addr() net.Addr { return tcpAddr("100.64.0.1", 80) }

// Preserve TCP half-close behavior but supply the addresses that a real tsnet
// connection exposes. No test starts tsnet or contacts the control plane.
type peerTCPConn struct{ *net.TCPConn }

func (*peerTCPConn) RemoteAddr() net.Addr { return tcpAddr("100.64.0.2", 54321) }
func (*peerTCPConn) LocalAddr() net.Addr  { return tcpAddr("100.64.0.1", 80) }

func tcpPair(t *testing.T) (*net.TCPConn, *peerTCPConn) {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", tcpAddr("127.0.0.1", 0))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialTCP("tcp4", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	server, err := listener.AcceptTCP()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	client.SetDeadline(time.Now().Add(3 * time.Second))
	server.SetDeadline(time.Now().Add(3 * time.Second))
	return client, &peerTCPConn{server}
}

func backendListener(t *testing.T) *net.TCPListener {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", tcpAddr("127.0.0.1", 0))
	if err != nil {
		t.Fatal(err)
	}
	listener.SetDeadline(time.Now().Add(3 * time.Second))
	t.Cleanup(func() { listener.Close() })
	return listener
}

func acceptBackend(t *testing.T, listener *net.TCPListener) *net.TCPConn {
	t.Helper()
	conn, err := listener.AcceptTCP()
	if err != nil {
		t.Fatal(err)
	}
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	t.Cleanup(func() { conn.Close() })
	return conn
}

func sendPeer(t *testing.T, listener *testListener, peer net.Conn) {
	t.Helper()
	select {
	case listener.incoming <- peer:
	case <-time.After(3 * time.Second):
		t.Fatal("forwarder did not accept")
	}
}

func startForwarder(t *testing.T, f *forwarder) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.serve(ctx); close(done) }()
	t.Cleanup(func() { cancel(); await(t, done) })
	return cancel, done
}

func TestForwardingPrefixesIdentityAndPreservesHalfClose(t *testing.T) {
	backend := backendListener(t)
	listener := newTestListener()
	forwarder := newForwarder(listener, backend.Addr().String())
	cancel, done := startForwarder(t, forwarder)
	client, peer := tcpPair(t)
	sendPeer(t, listener, peer)
	server := acceptBackend(t, backend)

	payload := "GET / HTTP/1.1\r\nHost: nootify.example.ts.net\r\nTailscale-User-Login: attacker@example.com\r\n\r\n"
	if _, err := io.WriteString(client, payload); err != nil {
		t.Fatal(err)
	}
	if err := client.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(server)
	header, err := reader.ReadString('\n')
	if err != nil || header != "PROXY TCP4 100.64.0.2 100.64.0.1 54321 80\r\n" {
		t.Fatalf("header = %q, %v", header, err)
	}
	body, err := io.ReadAll(reader)
	if err != nil || string(body) != payload {
		t.Fatalf("request payload = %q, %v", body, err)
	}
	response := "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"
	if _, err := io.WriteString(server, response); err != nil {
		t.Fatal(err)
	}
	if err := server.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(client)
	if err != nil || string(got) != response {
		t.Fatalf("response after half-close = %q, %v", got, err)
	}
	cancel()
	await(t, done)
	if forwarder.listening.Load() {
		t.Fatal("listener still reported active after shutdown")
	}
	forwarder.mu.Lock()
	defer forwarder.mu.Unlock()
	if len(forwarder.connections) != 0 {
		t.Fatal("forwarded sockets still tracked after shutdown")
	}
}

func TestForwarderCancellationClosesBothSockets(t *testing.T) {
	backend := backendListener(t)
	listener := newTestListener()
	forwarder := newForwarder(listener, backend.Addr().String())
	cancel, done := startForwarder(t, forwarder)
	client, peer := tcpPair(t)
	sendPeer(t, listener, peer)
	server := acceptBackend(t, backend)
	if _, err := bufio.NewReader(server).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	cancel()
	await(t, done)
	for _, conn := range []net.Conn{client, server} {
		_, err := conn.Read(make([]byte, 1))
		if err == nil {
			t.Fatal("connection still readable after cancellation")
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			t.Fatal("connection only closed by test deadline")
		}
	}
	await(t, listener.closed)
}

func TestForwarderCancellationAbortsPendingDial(t *testing.T) {
	listener := newTestListener()
	forwarder := newForwarder(listener, "127.0.0.1:12345")
	entered := make(chan struct{})
	forwarder.dial = func(ctx context.Context, network, target string) (net.Conn, error) {
		if network != "tcp4" || target != "127.0.0.1:12345" {
			return nil, errors.New("wrong_target")
		}
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	cancel, done := startForwarder(t, forwarder)
	_, peer := tcpPair(t)
	sendPeer(t, listener, peer)
	await(t, entered)
	cancel()
	await(t, done)
}

func TestForwarderDoesNotDialForInvalidPeer(t *testing.T) {
	listener := newTestListener()
	forwarder := newForwarder(listener, "127.0.0.1:12345")
	forwarder.dial = func(context.Context, string, string) (net.Conn, error) {
		t.Error("dialed for invalid identity")
		return nil, errors.New("unexpected_dial")
	}
	cancel, done := startForwarder(t, forwarder)
	client, peer := net.Pipe() // pipe addresses cannot supply an authenticated TCP endpoint
	defer client.Close()
	sendPeer(t, listener, peer)
	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, err := client.Read(make([]byte, 1))
	if err != io.EOF && !strings.Contains(fmtError(err), "closed") {
		t.Fatalf("invalid peer not closed: %v", err)
	}
	cancel()
	await(t, done)
}

func fmtError(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
