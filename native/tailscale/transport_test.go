package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestTailnetDestinationValidation(t *testing.T) {
	for raw, want := range map[string]string{
		"100.64.0.2:7443":               "100.64.0.2:7443",
		"[::ffff:100.64.0.2]:7443":      "100.64.0.2:7443",
		"[fd7a:115c:a1e0::2]:65535":     "[fd7a:115c:a1e0::2]:65535",
		"Node.My-Tailnet.ts.net.:07443": "node.my-tailnet.ts.net:7443",
	} {
		if got, err := validateTailnetAddress(raw); err != nil || got != want {
			t.Errorf("validate %q = %q, %v", raw, got, err)
		}
	}
	for _, raw := range []string{
		"", "peer", "peer:7443", "localhost:7443", "127.0.0.1:7443", "[::1]:7443",
		"192.168.1.1:7443", "8.8.8.8:7443", "[2001:db8::1]:7443", "[fd00::1]:7443",
		"0.0.0.0:7443", "[::]:7443", "224.0.0.1:7443", "100.100.100.100:53",
		"[fd7a:115c:a1e0::53]:53", "[fd7a:115c:a1e0:b1a::1]:7443",
		"[fd7a:115c:a1e0::2%en0]:7443", "[::ffff:100.64.0.2%en0]:7443", "100.64.0.2:0", "100.64.0.2:65536",
		"100.64.0.2:-1", "100.64.0.2:+80", "100.64.0.2:http", "100.64.0.2:80\n",
		"https://node.tail.ts.net:7443", "node.tail.ts.net:7443/path", "user@node.tail.ts.net:7443",
		"example.com:7443", "ts.net:7443", "node.ts.net.evil.com:7443", "node..ts.net:7443",
		"node_.ts.net:7443", "-node.ts.net:7443", "node.ts.net..:7443", "[node.ts.net]:7443",
		"node.ts.net\r\n:7443", strings.Repeat("a", 64) + ".ts.net:7443",
	} {
		if _, err := validateTailnetAddress(raw); err == nil {
			t.Errorf("accepted destination %q", raw)
		}
	}
}

func TestPublicationValidation(t *testing.T) {
	for _, raw := range []string{"127.0.0.1:7443", "127.0.0.2:7443", "[::1]:7443", "[::ffff:127.0.0.1]:7443"} {
		if _, err := validateLoopbackAddress(raw); err != nil {
			t.Errorf("rejected loopback %q", raw)
		}
	}
	for _, raw := range []string{
		"", "localhost:7443", "tcp://127.0.0.1:7443", "127.0.0.1:0", "127.0.0.1:65536",
		"127.0.0.1:http", "127.0.0.1:7443/path", "127.0.0.1:7443\n", "[::1%lo0]:7443",
		"0.0.0.0:7443", "[::]:7443", "100.64.0.1:7443", "192.168.0.1:7443", "[fd7a:115c:a1e0::1]:7443",
	} {
		if _, err := validateLoopbackAddress(raw); err == nil {
			t.Errorf("accepted target %q", raw)
		}
	}
	m := testTCPTransport(t, nil, nil)
	for _, port := range []int{-1, 0, 80, 65536} {
		for _, method := range []string{"publish", "unpublish"} {
			if reply := m.dispatch(context.Background(), request{ID: 1, Method: method, Port: port, Target: "127.0.0.1:7443"}); reply.Error != "invalid_port" {
				t.Fatal(reply)
			}
		}
	}
	for _, id := range []string{"", strings.Repeat("a", 65)} {
		if reply := m.dispatch(context.Background(), request{ID: 2, Method: "close_tunnel", TunnelID: id}); reply.Error != "invalid_tunnel_id" {
			t.Fatal(reply)
		}
	}
	if reply := m.dispatch(context.Background(), request{ID: 3, Method: "tunnel", Address: "127.0.0.1:7443"}); reply.Error != "invalid_address" {
		t.Fatal(reply)
	}
	if reply := m.dispatch(context.Background(), request{ID: 4, Method: "publish", Port: 7443, Target: "localhost:7443"}); reply.Error != "invalid_target" {
		t.Fatal(reply)
	}
}

func testTCPTransport(t *testing.T, dial func(context.Context, string, string) (net.Conn, error), listenPort func(int) (net.Listener, error)) *tcpTransport {
	t.Helper()
	m := newTCPTransport(context.Background(), dial, listenPort)
	t.Cleanup(m.close)
	return m
}

func dialLoopback(t *testing.T, address string) *net.TCPConn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	return conn.(*net.TCPConn)
}

func assertSocketClosed(t *testing.T, conn net.Conn) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(time.Second))
	_, err := conn.Read(make([]byte, 1))
	var netErr net.Error
	if err == nil || (errors.As(err, &netErr) && netErr.Timeout()) {
		t.Fatalf("socket not closed: %v", err)
	}
}

func assertNotListening(t *testing.T, address string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err == nil {
		conn.Close()
		t.Fatalf("listener still reachable at %s", address)
	}
}

func bridgeFor(t *testing.T, m *tcpTransport, id string, port int) *tcpBridge {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	b := m.tunnels[id]
	if port != 0 {
		b = m.publications[port]
	}
	if b == nil {
		t.Fatal("bridge missing")
	}
	return b
}

func TestRawTransportsPreserveBytesAndHalfClose(t *testing.T) {
	for _, method := range []string{"tunnel", "publish"} {
		t.Run(method, func(t *testing.T) {
			backend := backendListener(t)
			tailListener := backendListener(t)
			calls := make(chan string, 1)
			m := testTCPTransport(t, func(ctx context.Context, network, address string) (net.Conn, error) {
				calls <- network + " " + address
				return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Addr().String())
			}, func(port int) (net.Listener, error) {
				if port != 7443 {
					return nil, errors.New("unexpected_port")
				}
				return tailListener, nil
			})
			d := newDispatcher(fakeClient{})
			d.transport = m
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			reply := d.dispatch(ctx, request{ID: 17, Method: method, Address: "Node.Tail.ts.net.:7443", Port: 7443, Target: backend.Addr().String()})
			if reply.ID != 17 || reply.Error != "" {
				t.Fatal(reply)
			}
			address := tailListener.Addr().String()
			closeRequest := request{ID: 18, Method: "unpublish", Port: 7443}
			if method == "tunnel" {
				result := reply.Result.(tunnelResult)
				if result.ID == "" || !strings.HasPrefix(result.Address, "127.0.0.1:") {
					t.Fatal(result)
				}
				address = result.Address
				closeRequest = request{ID: 18, Method: "close_tunnel", TunnelID: result.ID}
			} else if reply.Result.(publishResult).Port != 7443 {
				t.Fatal(reply)
			}
			// Completion of a short-lived RPC must not cancel its TCP listener.
			cancel()
			client := dialLoopback(t, address)
			server := acceptBackend(t, backend)
			if method == "tunnel" {
				if call := <-calls; call != "tcp node.tail.ts.net:7443" {
					t.Fatalf("dial escaped tsnet: %s", call)
				}
			}
			payload := []byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\x00\x01\xffgrpc-request")
			if _, err := client.Write(payload); err != nil {
				t.Fatal(err)
			}
			if err := client.CloseWrite(); err != nil {
				t.Fatal(err)
			}
			if got, err := io.ReadAll(server); err != nil || !bytes.Equal(got, payload) {
				t.Fatalf("request altered (PROXY preamble must be absent): %q, %v", got, err)
			}
			response := []byte("\x00\x00\x01\xffgrpc-response")
			if _, err := server.Write(response); err != nil {
				t.Fatal(err)
			}
			if err := server.CloseWrite(); err != nil {
				t.Fatal(err)
			}
			if got, err := io.ReadAll(client); err != nil || !bytes.Equal(got, response) {
				t.Fatalf("response after half-close = %q, %v", got, err)
			}
			for range 2 { // Closing an already-closed allocation is idempotent.
				if got := d.dispatch(context.Background(), closeRequest); got.Error != "" {
					t.Fatal(got)
				}
			}
			assertNotListening(t, address)
			if len(m.slots) != 0 {
				t.Fatal("connection slot leaked after EOF/close")
			}
		})
	}
}

func TestCloseRawTransportsClosesActiveSockets(t *testing.T) {
	for _, method := range []string{"tunnel", "publish"} {
		t.Run(method, func(t *testing.T) {
			backend := backendListener(t)
			listener := backendListener(t)
			m := testTCPTransport(t, func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Addr().String())
			}, func(int) (net.Listener, error) { return listener, nil })
			reply := m.dispatch(context.Background(), request{ID: 1, Method: method, Address: "100.64.0.2:7443", Port: 7443, Target: backend.Addr().String()})
			if reply.Error != "" {
				t.Fatal(reply)
			}
			address := listener.Addr().String()
			closeReq := request{ID: 2, Method: "unpublish", Port: 7443}
			if method == "tunnel" {
				result := reply.Result.(tunnelResult)
				address = result.Address
				closeReq = request{ID: 2, Method: "close_tunnel", TunnelID: result.ID}
			}
			client := dialLoopback(t, address)
			server := acceptBackend(t, backend)
			if reply := m.dispatch(context.Background(), closeReq); reply.Error != "" {
				t.Fatal(reply)
			}
			assertSocketClosed(t, client)
			assertSocketClosed(t, server)
			assertNotListening(t, address)
		})
	}
}

func TestTunnelCloseCancelsPendingDialAndDialErrorsCloseClient(t *testing.T) {
	for _, fails := range []bool{false, true} {
		t.Run(fmt.Sprint(fails), func(t *testing.T) {
			entered, exited := make(chan struct{}), make(chan struct{})
			m := testTCPTransport(t, func(ctx context.Context, _, _ string) (net.Conn, error) {
				close(entered)
				defer close(exited)
				if fails {
					return nil, errors.New("secret-credentials-must-not-escape")
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Error("tsnet dial has no timeout")
				}
				<-ctx.Done()
				return nil, ctx.Err()
			}, nil)
			reply := m.dispatch(context.Background(), request{ID: 1, Method: "tunnel", Address: "100.64.0.2:7443"})
			if reply.Error != "" {
				t.Fatal(reply)
			}
			result := reply.Result.(tunnelResult)
			client := dialLoopback(t, result.Address)
			await(t, entered)
			if fails {
				assertSocketClosed(t, client)
			}
			if reply := m.dispatch(context.Background(), request{ID: 2, Method: "close_tunnel", TunnelID: result.ID}); reply.Error != "" {
				t.Fatal(reply)
			}
			await(t, exited)
			assertSocketClosed(t, client)
		})
	}
}

func TestRawListenerFailuresAreRedactedAndReleaseReservations(t *testing.T) {
	for _, method := range []string{"tunnel", "publish"} {
		for _, failure := range []string{"nil", "error", "error-with-listener", "accept"} {
			t.Run(method+"/"+failure, func(t *testing.T) {
				listener := newTestListener()
				secret := errors.New("https://login.tailscale.com/a/must-not-escape")
				open := func() (net.Listener, error) {
					switch failure {
					case "nil":
						return nil, nil
					case "error":
						return nil, secret
					case "error-with-listener":
						return listener, secret
					default:
						return listener, nil
					}
				}
				m := testTCPTransport(t, nil, func(int) (net.Listener, error) { return open() })
				m.listen = func(context.Context) (net.Listener, error) { return open() }
				req := request{ID: 1, Method: method, Address: "100.64.0.2:7443", Port: 7443, Target: "127.0.0.1:12345"}
				reply := m.dispatch(context.Background(), req)
				if failure == "accept" {
					if reply.Error != "" {
						t.Fatal(reply)
					}
					id, port := "", 7443
					if method == "tunnel" {
						id, port = reply.Result.(tunnelResult).ID, 0
					}
					b := bridgeFor(t, m, id, port)
					await(t, listener.accepting)
					listener.fail <- secret
					await(t, b.done)
					await(t, listener.closed)
				} else {
					if reply.Error != "listener_failed" || strings.Contains(string(encodeResponse(reply)), "must-not-escape") {
						t.Fatal(reply)
					}
					if failure == "error-with-listener" {
						await(t, listener.closed)
					}
				}
				m.mu.Lock()
				remaining := len(m.tunnels) + len(m.publications)
				m.mu.Unlock()
				if remaining != 0 {
					t.Fatal("failed listener kept reservation")
				}
				// The same tailnet port can be published after a failed allocation.
				failure = "success"
				listener = newTestListener()
				if reply := m.dispatch(context.Background(), req); reply.Error != "" {
					t.Fatal(reply)
				}
			})
		}
	}
}

func TestRawTransportAllocationLimitsAndReuse(t *testing.T) {
	m := testTCPTransport(t, nil, func(int) (net.Listener, error) { return newTestListener(), nil })
	var first string
	for i := range maxTunnels {
		reply := m.dispatch(context.Background(), request{ID: 1, Method: "tunnel", Address: "100.64.0.2:7443"})
		if reply.Error != "" {
			t.Fatal(reply)
		}
		if i == 0 {
			first = reply.Result.(tunnelResult).ID
		}
	}
	if reply := m.dispatch(context.Background(), request{ID: 2, Method: "tunnel", Address: "100.64.0.2:7443"}); reply.Error != "tunnel_limit" {
		t.Fatal(reply)
	}
	m.dispatch(context.Background(), request{ID: 3, Method: "close_tunnel", TunnelID: first})
	if reply := m.dispatch(context.Background(), request{ID: 4, Method: "tunnel", Address: "100.64.0.2:7443"}); reply.Error != "" || reply.Result.(tunnelResult).ID == first {
		t.Fatal(reply)
	}
	for i := range maxPublications {
		if reply := m.dispatch(context.Background(), request{ID: 5, Method: "publish", Port: 7443 + i, Target: "127.0.0.1:12345"}); reply.Error != "" {
			t.Fatal(reply)
		}
	}
	for port, code := range map[int]string{7443: "port_in_use", 8443: "publication_limit"} {
		if reply := m.dispatch(context.Background(), request{ID: 6, Method: "publish", Port: port, Target: "127.0.0.1:12345"}); reply.Error != code {
			t.Fatal(reply)
		}
	}
	m.dispatch(context.Background(), request{ID: 7, Method: "unpublish", Port: 7443})
	if reply := m.dispatch(context.Background(), request{ID: 8, Method: "publish", Port: 7443, Target: "127.0.0.1:12345"}); reply.Error != "" {
		t.Fatal(reply)
	}
	m.close()
	m.close()
	if len(m.tunnels)+len(m.publications) != 0 {
		t.Fatal("shutdown kept allocations")
	}
	if reply := m.dispatch(context.Background(), request{ID: 9, Method: "tunnel", Address: "100.64.0.2:7443"}); reply.Error != "canceled" {
		t.Fatal(reply)
	}
}

func TestRawConnectionLimitSharedAcrossTransports(t *testing.T) {
	backend := backendListener(t)
	listener := backendListener(t)
	entered := make(chan struct{})
	m := testTCPTransport(t, func(ctx context.Context, _, _ string) (net.Conn, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}, func(int) (net.Listener, error) { return listener, nil })
	m.slots = make(chan struct{}, 1)
	reply := m.dispatch(context.Background(), request{ID: 1, Method: "tunnel", Address: "100.64.0.2:7443"})
	result := reply.Result.(tunnelResult)
	client := dialLoopback(t, result.Address)
	await(t, entered)
	if reply := m.dispatch(context.Background(), request{ID: 2, Method: "publish", Port: 7443, Target: backend.Addr().String()}); reply.Error != "" {
		t.Fatal(reply)
	}
	rejected := dialLoopback(t, listener.Addr().String())
	assertSocketClosed(t, rejected)
	m.dispatch(context.Background(), request{ID: 3, Method: "close_tunnel", TunnelID: result.ID})
	assertSocketClosed(t, client)
	accepted := dialLoopback(t, listener.Addr().String())
	server := acceptBackend(t, backend)
	m.dispatch(context.Background(), request{ID: 4, Method: "unpublish", Port: 7443})
	assertSocketClosed(t, accepted)
	assertSocketClosed(t, server)
}

func TestRawAllocationCancellationClosesLateListener(t *testing.T) {
	for _, method := range []string{"tunnel", "publish"} {
		t.Run(method, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			listener := newTestListener()
			open := func() (net.Listener, error) { close(entered); <-release; return listener, nil }
			m := testTCPTransport(t, nil, func(int) (net.Listener, error) { return open() })
			m.listen = func(context.Context) (net.Listener, error) { return open() }
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan response, 1)
			go func() {
				result <- m.dispatch(ctx, request{ID: 1, Method: method, Address: "100.64.0.2:7443", Port: 7443, Target: "127.0.0.1:12345"})
			}()
			await(t, entered)
			cancel()
			close(release)
			select {
			case reply := <-result:
				if reply.Error != "canceled" {
					t.Fatal(reply)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("allocation blocked after cancellation")
			}
			await(t, listener.closed)
			if len(m.tunnels)+len(m.publications) != 0 {
				t.Fatal("canceled allocation leaked")
			}
		})
	}
}

func TestServiceEOFAndShutdownCloseRawTransports(t *testing.T) {
	for _, reason := range []string{"stdin-eof", "signal-context"} {
		t.Run(reason, func(t *testing.T) {
			tunnelBackend, publishBackend := backendListener(t), backendListener(t)
			published := backendListener(t)
			httpListener := newTestListener()
			node := &fakeNode{
				client: fakeClient{}, listener: httpListener,
				dial: func(ctx context.Context, network, address string) (net.Conn, error) {
					if network != "tcp" || address != "100.64.0.2:7443" {
						return nil, errors.New("wrong_tsnet_destination")
					}
					return (&net.Dialer{}).DialContext(ctx, "tcp", tunnelBackend.Addr().String())
				},
				listenPort: func(port int) (net.Listener, error) {
					if port != 7443 {
						return nil, errors.New("wrong_tsnet_port")
					}
					return published, nil
				},
			}
			h := startTestService(t, config{}, node)
			h.ready(t)
			h.send(t, "{\"id\":1,\"method\":\"tunnel\",\"address\":\"100.64.0.2:7443\"}\n")
			reply := h.read(t)
			if reply.ID != 1 || reply.Error != "" {
				t.Fatal(reply)
			}
			address := reply.Result.(map[string]any)["address"].(string)
			tunnelClient := dialLoopback(t, address)
			tunnelServer := acceptBackend(t, tunnelBackend)
			h.send(t, fmt.Sprintf("{\"id\":2,\"method\":\"publish\",\"port\":7443,\"target\":%q}\n", publishBackend.Addr().String()))
			if reply := h.read(t); reply.ID != 2 || reply.Error != "" || reply.Result.(map[string]any)["port"] != float64(7443) {
				t.Fatal(reply)
			}
			publishClient := dialLoopback(t, published.Addr().String())
			publishServer := acceptBackend(t, publishBackend)
			if reason == "stdin-eof" {
				h.input.Close()
			} else {
				h.cancel()
			}
			await(t, h.done)
			if h.err != nil || node.closed.Load() != 1 {
				t.Fatalf("shutdown: %v, closed=%d", h.err, node.closed.Load())
			}
			for _, conn := range []net.Conn{tunnelClient, tunnelServer, publishClient, publishServer} {
				assertSocketClosed(t, conn)
			}
			assertNotListening(t, address)
			assertNotListening(t, published.Addr().String())
			await(t, httpListener.closed)
		})
	}
}
