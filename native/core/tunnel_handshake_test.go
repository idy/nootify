package main

import (
	"context"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

var fixtureTunnelToken = strings.Repeat("ab", 32)

// A private synthetic helper endpoint for core transport fixtures. Its only
// upstream is a caller-owned loopback listener; it never starts tsnet.
func testAuthenticatedTunnelBridge(t *testing.T, target string) string {
	t.Helper()
	listener := testPrivateTunnelListener(t)
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	connections := map[net.Conn]bool{}
	var workers sync.WaitGroup
	track := func(conn net.Conn) bool {
		mu.Lock()
		defer mu.Unlock()
		if ctx.Err() != nil {
			conn.Close()
			return false
		}
		connections[conn] = true
		return true
	}
	release := func(conn net.Conn) {
		conn.Close()
		mu.Lock()
		delete(connections, conn)
		mu.Unlock()
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			peer, err := listener.Accept()
			if err != nil {
				return
			}
			if !track(peer) {
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer release(peer)
				peer.SetDeadline(time.Now().Add(3 * time.Second))
				frame := make([]byte, len(embeddedTunnelHandshakePrefix)+len(fixtureTunnelToken)+1)
				if _, err := io.ReadFull(peer, frame); err != nil || string(frame) != embeddedTunnelHandshakePrefix+fixtureTunnelToken+"\n" {
					return
				}
				if _, err := peer.Write([]byte{1}); err != nil {
					return
				}
				peer.SetDeadline(time.Time{})
				backend, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "tcp", target)
				if err != nil || !track(backend) {
					return
				}
				defer release(backend)
				done := make(chan struct{})
				copyOne := func(dst, src net.Conn) {
					if _, err := io.Copy(dst, src); err != nil {
						peer.Close()
						backend.Close()
					} else {
						dst.(interface{ CloseWrite() error }).CloseWrite()
					}
				}
				go func() { copyOne(backend, peer); close(done) }()
				copyOne(peer, backend)
				<-done
			}()
		}
	}()
	t.Cleanup(func() {
		cancel()
		listener.Close()
		mu.Lock()
		for conn := range connections {
			conn.Close()
		}
		mu.Unlock()
		workers.Wait()
	})
	return listener.Addr().String()
}

func TestCompleteDialRequiresPrivateTunnelToken(t *testing.T) {
	for _, token := range []string{"", "short-private-token", strings.Repeat("g", 64), strings.Repeat("AB", 32)} {
		c := testCore(t, nil)
		ch := make(chan dialResult, 1)
		c.dials["pending"] = ch
		err := c.completeDial("pending", "127.0.0.1:12345", "", token, "tcp")
		if err == nil || len(ch) != 0 {
			t.Fatal("invalid capability completed a tunnel allocation")
		}
		if token != "" && strings.Contains(err.Error(), token) {
			t.Fatal("private capability appeared in an error")
		}
	}
	c := testCore(t, nil)
	ch := make(chan dialResult, 1)
	c.dials["pending"] = ch
	listener := testPrivateTunnelListener(t)
	for _, network := range []string{"", "tcp", "tcp4"} {
		if err := c.completeDial("pending", "127.0.0.1:12345", "", fixtureTunnelToken, network); err == nil || len(ch) != 0 {
			t.Fatal("local TCP completion bypassed the OS owner boundary")
		}
	}
	must(t, c.completeDial("pending", listener.Addr().String(), "", fixtureTunnelToken, localTunnelNetwork))
	if result := <-ch; result.Token != fixtureTunnelToken || result.Error != "" {
		t.Fatal("private completion lost its authentication capability")
	}
	must(t, c.completeDial("pending", "", "private backend text", "", ""))
	if result := <-ch; result.Error == "" {
		t.Fatal("failed completion required an authentication capability")
	}
}

type tunnelDeadlineConn struct {
	net.Conn
	deadlines []time.Time
}

func (c *tunnelDeadlineConn) SetDeadline(deadline time.Time) error {
	c.deadlines = append(c.deadlines, deadline)
	return c.Conn.SetDeadline(deadline)
}

func TestEmbeddedTunnelHandshakePreservesFollowingBytesAndIdleStream(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	conn := &tunnelDeadlineConn{Conn: client}
	server.SetDeadline(time.Now().Add(3 * time.Second))
	payload := "\x00\x01HTTP2-response\xff"
	serverDone := make(chan error, 1)
	go func() {
		frame := make([]byte, len(embeddedTunnelHandshakePrefix)+len(fixtureTunnelToken)+1)
		_, err := io.ReadFull(server, frame)
		if err == nil && string(frame) != embeddedTunnelHandshakePrefix+fixtureTunnelToken+"\n" {
			t.Error("unexpected private tunnel authentication frame")
		}
		if err == nil {
			_, err = io.WriteString(server, "\x01"+payload)
		}
		serverDone <- err
	}()
	before := time.Now()
	must(t, authenticateEmbeddedTunnel(context.Background(), conn, fixtureTunnelToken))
	if len(conn.deadlines) != 2 || conn.deadlines[0].Before(before) || conn.deadlines[0].After(time.Now().Add(embeddedTunnelHandshakeTimeout)) || !conn.deadlines[1].IsZero() {
		t.Fatal("authentication deadline missing or retained on established stream")
	}
	got := make([]byte, len(payload))
	_, err := io.ReadFull(conn, got)
	must(t, err)
	if string(got) != payload {
		t.Fatal("authentication consumed following stream bytes")
	}
	must(t, <-serverDone)
}

func TestEmbeddedTunnelHandshakeCancellationAndFailureAreRedacted(t *testing.T) {
	for _, mode := range []string{"cancel", "wrong-ack", "closed"} {
		t.Run(mode, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- authenticateEmbeddedTunnel(ctx, client, fixtureTunnelToken) }()
			frame := make([]byte, len(embeddedTunnelHandshakePrefix)+len(fixtureTunnelToken)+1)
			server.SetReadDeadline(time.Now().Add(3 * time.Second))
			_, err := io.ReadFull(server, frame)
			must(t, err)
			switch mode {
			case "cancel":
				cancel()
			case "wrong-ack":
				_, err = server.Write([]byte{0})
				must(t, err)
			case "closed":
				server.Close()
			}
			select {
			case err := <-done:
				if err == nil || strings.Contains(err.Error(), fixtureTunnelToken) {
					t.Fatal("failed tunnel handshake accepted or exposed its capability")
				}
			case <-time.After(time.Second):
				t.Fatal("failed handshake did not complete promptly")
			}
		})
	}
}
