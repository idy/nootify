package main

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// Observe the production handshake deadline and expire it explicitly. No test
// needs to wait out the authentication timer or start an embedded tsnet node.
type deadlineObservedConn struct {
	net.Conn
	deadlines chan time.Time
	closed    chan struct{}
	once      sync.Once
}

func (c *deadlineObservedConn) SetDeadline(deadline time.Time) error {
	c.deadlines <- deadline
	return c.Conn.SetDeadline(deadline)
}

func (c *deadlineObservedConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

func TestTunnelRejectsInvalidCapabilitiesBeforeEmbeddedDial(t *testing.T) {
	for _, kind := range []string{"wrong", "other-allocation", "bad-version", "http", "truncated"} {
		t.Run(kind, func(t *testing.T) {
			listener := newTestListener()
			dials := make(chan struct{}, 1)
			m := testTCPTransport(t, func(context.Context, string, string) (net.Conn, error) {
				dials <- struct{}{}
				return nil, errors.New("must_not_dial")
			}, nil)
			m.listen = func(context.Context) (net.Listener, error) { return listener, nil }
			reply := m.dispatch(context.Background(), request{ID: 1, Method: "tunnel", Address: "100.64.0.2:7443"})
			if reply.Error != "" {
				t.Fatal(reply.Error)
			}
			result := reply.Result.(tunnelResult)
			if decoded, err := hex.DecodeString(result.Token); err != nil || len(decoded) != tunnelTokenBytes || result.Token != strings.ToLower(result.Token) {
				t.Fatal("invalid private tunnel capability format")
			}
			b := bridgeFor(t, m, result.ID, 0)
			frame := tunnelHandshakePrefix + result.Token + "\n"
			switch kind {
			case "wrong":
				frame = tunnelHandshakePrefix + strings.Repeat("0", 64) + "\n"
			case "other-allocation":
				other, err := m.reserve(context.Background(), 0)
				if err != nil {
					t.Fatal(err)
				}
				if other.token == result.Token {
					t.Fatal("allocations reused a capability")
				}
				frame = tunnelHandshakePrefix + other.token + "\n"
				m.finish(other)
			case "bad-version":
				frame = strings.Replace(frame, "/1 ", "/0 ", 1)
			case "http":
				frame = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
			case "truncated":
				frame = frame[:len(frame)-1]
			}
			client, peer := tcpPair(t)
			sendPeer(t, listener, peer)
			if _, err := io.WriteString(client, frame); err != nil {
				t.Fatal(err)
			}
			client.CloseWrite()
			assertSocketClosed(t, client)
			m.close()
			if len(dials) != 0 || len(b.pending)+len(b.limit.reserved)+len(b.limit.burst)+len(m.sharedSlots) != 0 {
				t.Fatal("unauthorized client dialed upstream or leaked admission capacity")
			}
		})
	}
}

func TestTunnelPendingAuthenticationBoundedAndIsolated(t *testing.T) {
	backend := backendListener(t)
	listeners := []*testListener{newTestListener(), newTestListener()}
	index := 0
	m := testTCPTransport(t, func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Addr().String())
	}, nil)
	m.listen = func(context.Context) (net.Listener, error) {
		listener := listeners[index]
		index++
		return listener, nil
	}
	first := m.dispatch(context.Background(), request{ID: 1, Method: "tunnel", Address: "100.64.0.2:7443"}).Result.(tunnelResult)
	second := m.dispatch(context.Background(), request{ID: 2, Method: "tunnel", Address: "100.64.0.3:7443"}).Result.(tunnelResult)
	b := bridgeFor(t, m, first.ID, 0)
	owner, ownerPeer := tcpPair(t)
	sendPeer(t, listeners[0], ownerPeer)
	authenticateTunnelClient(t, owner, first.Token)
	ownerBackend := acceptBackend(t, backend)

	var pending []*deadlineObservedConn
	var clients []net.Conn
	for range maxPendingTunnelHandshakes {
		client, peer := tcpPair(t)
		conn := &deadlineObservedConn{Conn: peer, deadlines: make(chan time.Time, 2), closed: make(chan struct{})}
		before := time.Now()
		sendPeer(t, listeners[0], conn)
		select {
		case deadline := <-conn.deadlines:
			if deadline.Before(before) || deadline.After(time.Now().Add(tunnelHandshakeTimeout)) {
				t.Fatal("missing or excessive pending handshake deadline")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("no authentication deadline")
		}
		// A slow partial frame remains unauthenticated.
		if _, err := io.WriteString(client, tunnelHandshakePrefix); err != nil {
			t.Fatal(err)
		}
		pending = append(pending, conn)
		clients = append(clients, client)
	}
	if len(b.pending) != maxPendingTunnelHandshakes || len(b.limit.reserved) != 1 || len(m.sharedSlots) != 0 {
		t.Fatal("pending authentication consumed authenticated stream capacity")
	}
	extra, extraPeer := tcpPair(t)
	sendPeer(t, listeners[0], extraPeer)
	assertSocketClosed(t, extra)
	other, otherPeer := tcpPair(t)
	sendPeer(t, listeners[1], otherPeer)
	authenticateTunnelClient(t, other, second.Token)
	otherBackend := acceptBackend(t, backend)
	for i, conn := range pending {
		conn.Conn.SetReadDeadline(time.Now().Add(-time.Second))
		assertSocketClosed(t, clients[i])
		await(t, conn.closed)
	}
	// Timed-out unauthenticated peers neither shorten an owner's idle stream
	// nor affect another tunnel. Both established streams still carry bytes.
	for i, client := range []net.Conn{owner, other} {
		if _, err := client.Write([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
		var data [1]byte
		server := []net.Conn{ownerBackend, otherBackend}[i]
		if _, err := io.ReadFull(server, data[:]); err != nil || data[0] != byte(i) {
			t.Fatal("authenticated stream disrupted by pending handshake expiry")
		}
	}
	m.close()
	if len(b.pending)+len(b.limit.reserved)+len(b.limit.burst)+len(m.sharedSlots) != 0 {
		t.Fatal("handshake shutdown leaked capacity")
	}
}

func TestTunnelAuthenticationConsumesOnlyFrameAndClearsDeadline(t *testing.T) {
	backend := backendListener(t)
	listener := newTestListener()
	m := testTCPTransport(t, func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Addr().String())
	}, nil)
	m.listen = func(context.Context) (net.Listener, error) { return listener, nil }
	result := m.dispatch(context.Background(), request{ID: 1, Method: "tunnel", Address: "100.64.0.2:7443"}).Result.(tunnelResult)
	client, peer := tcpPair(t)
	conn := &deadlineObservedConn{Conn: peer, deadlines: make(chan time.Time, 2), closed: make(chan struct{})}
	sendPeer(t, listener, conn)
	payload := "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\x00\x01\xff"
	if _, err := io.WriteString(client, tunnelHandshakePrefix+result.Token+"\n"+payload); err != nil {
		t.Fatal(err)
	}
	var ack [1]byte
	if _, err := io.ReadFull(client, ack[:]); err != nil || ack[0] != 1 {
		t.Fatal("private tunnel acknowledgment missing")
	}
	server := acceptBackend(t, backend)
	<-conn.deadlines
	select {
	case deadline := <-conn.deadlines:
		if !deadline.IsZero() {
			t.Fatal("authenticated stream retained handshake deadline")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("handshake deadline not cleared")
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(server, got); err != nil || string(got) != payload {
		t.Fatal("capability bytes escaped upstream or pipelined payload changed")
	}
	m.close()
}

func TestTunnelCloseCancelsPendingAuthentication(t *testing.T) {
	listener := newTestListener()
	m := testTCPTransport(t, func(context.Context, string, string) (net.Conn, error) {
		t.Error("unauthenticated connection dialed upstream")
		return nil, errors.New("unexpected_dial")
	}, nil)
	m.listen = func(context.Context) (net.Listener, error) { return listener, nil }
	result := m.dispatch(context.Background(), request{ID: 1, Method: "tunnel", Address: "100.64.0.2:7443"}).Result.(tunnelResult)
	b := bridgeFor(t, m, result.ID, 0)
	client, peer := tcpPair(t)
	conn := &deadlineObservedConn{Conn: peer, deadlines: make(chan time.Time, 2), closed: make(chan struct{})}
	sendPeer(t, listener, conn)
	select {
	case <-conn.deadlines:
	case <-time.After(3 * time.Second):
		t.Fatal("pending handshake did not begin")
	}
	if reply := m.dispatch(context.Background(), request{ID: 2, Method: "close_tunnel", TunnelID: result.ID}); reply.Error != "" {
		t.Fatal(reply.Error)
	}
	await(t, conn.closed)
	assertSocketClosed(t, client)
	if len(b.pending) != 0 {
		t.Fatal("cancellation retained a pending authentication slot")
	}
}
