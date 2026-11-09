package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxProxyHeaderBytes   = 108
	maxForwardConnections = 128
	backendTimeout        = 3 * time.Second
)

func parseIP(raw string) (netip.Addr, error) {
	addr, err := netip.ParseAddr(raw)
	if err != nil || addr.Zone() != "" || !addr.IsGlobalUnicast() {
		return netip.Addr{}, errors.New("invalid_ip")
	}
	return addr.Unmap(), nil
}

func tcpEndpoint(addr net.Addr) (netip.AddrPort, error) {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok || tcp == nil || tcp.Zone != "" || tcp.Port < 1 || tcp.Port > 65535 {
		return netip.AddrPort{}, errors.New("invalid_peer_address")
	}
	ip, ok := netip.AddrFromSlice(tcp.IP)
	if !ok || !ip.IsGlobalUnicast() {
		return netip.AddrPort{}, errors.New("invalid_peer_address")
	}
	return netip.AddrPortFrom(ip.Unmap(), uint16(tcp.Port)), nil
}

// The only identity source is the accepted tsnet connection. No client bytes or
// HTTP headers are parsed, and invalid endpoints fail closed (never UNKNOWN).
func proxyHeader(remote, local net.Addr) (string, error) {
	src, err := tcpEndpoint(remote)
	if err != nil {
		return "", err
	}
	dst, err := tcpEndpoint(local)
	if err != nil || src.Addr().Is4() != dst.Addr().Is4() {
		return "", errors.New("invalid_peer_address")
	}
	family := "TCP6"
	if src.Addr().Is4() {
		family = "TCP4"
	}
	header := fmt.Sprintf("PROXY %s %s %s %d %d\r\n", family, src.Addr(), dst.Addr(), src.Port(), dst.Port())
	if len(header) > maxProxyHeaderBytes {
		return "", errors.New("invalid_proxy_header")
	}
	return header, nil
}

// A bridge keeps its own reserved capacity even when other bridges exhaust the
// shared burst pool. Neither admission nor release changes a stream's lifetime.
// HTTP uses only reserved slots, independently of the raw bridge limits.
type connectionLimit struct {
	reserved chan struct{}
	burst    chan struct{}
	shared   chan struct{}
}

func (l connectionLimit) acquire() func() {
	select {
	case l.reserved <- struct{}{}:
		return func() { <-l.reserved }
	default:
	}
	if l.shared == nil {
		return nil
	}
	select {
	case l.burst <- struct{}{}:
	default:
		return nil
	}
	select {
	case l.shared <- struct{}{}:
		return func() { <-l.shared; <-l.burst }
	default:
		<-l.burst
		return nil
	}
}

type forwarder struct {
	listener  net.Listener
	target    string
	dial      func(context.Context, string, string) (net.Conn, error)
	raw       bool // raw RPC transports never emit an HTTP PROXY preamble
	limit     connectionLimit
	token     string // nonempty only for authenticated local tunnel ingress
	pending   chan struct{}
	listening atomic.Bool

	mu          sync.Mutex
	closed      bool
	connections map[net.Conn]struct{}
}

func newForwarder(listener net.Listener, target string) *forwarder {
	dialer := &net.Dialer{Timeout: backendTimeout, KeepAlive: 30 * time.Second}
	return &forwarder{
		listener:    listener,
		target:      target,
		dial:        dialer.DialContext,
		limit:       connectionLimit{reserved: make(chan struct{}, maxForwardConnections)},
		connections: make(map[net.Conn]struct{}),
	}
}

func (f *forwarder) track(conn net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		conn.Close()
		return false
	}
	f.connections[conn] = struct{}{}
	return true
}

func (f *forwarder) release(conn net.Conn) {
	conn.Close()
	f.mu.Lock()
	delete(f.connections, conn)
	f.mu.Unlock()
}

func (f *forwarder) close() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	f.listening.Store(false)
	connections := make([]net.Conn, 0, len(f.connections))
	for conn := range f.connections {
		connections = append(connections, conn)
	}
	f.mu.Unlock()
	f.listener.Close()
	for _, conn := range connections {
		conn.Close()
	}
}

func (f *forwarder) serve(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	var workers sync.WaitGroup
	defer func() { cancel(); f.close(); workers.Wait() }()
	stop := context.AfterFunc(ctx, f.close)
	defer stop()
	f.mu.Lock()
	if f.closed || ctx.Err() != nil {
		f.mu.Unlock()
		return nil
	}
	f.listening.Store(true)
	f.mu.Unlock()

	for {
		conn, err := f.listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		limit := f.limit
		if f.token != "" {
			limit = connectionLimit{reserved: f.pending}
		}
		release := limit.acquire()
		if release == nil {
			conn.Close()
			continue
		}
		if !f.track(conn) {
			release()
			return nil
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() {
				if release != nil {
					release()
				}
			}()
			defer f.release(conn)
			if f.token != "" {
				if !f.authenticateTunnel(conn) {
					return
				}
				// Authentication has its own bounded budget. Only an authenticated
				// client may consume raw capacity or cause an embedded-identity dial.
				release()
				release = f.limit.acquire()
				if release == nil {
					return
				}
				if n, err := conn.Write([]byte{1}); err != nil || n != 1 {
					return
				}
				if err := conn.SetDeadline(time.Time{}); err != nil {
					return
				}
			}
			f.forward(ctx, conn)
		}()
	}
}

func (f *forwarder) authenticateTunnel(peer net.Conn) bool {
	if err := peer.SetDeadline(time.Now().Add(tunnelHandshakeTimeout)); err != nil {
		return false
	}
	var received [len(tunnelHandshakePrefix) + 2*tunnelTokenBytes + 1]byte
	if _, err := io.ReadFull(peer, received[:]); err != nil {
		return false
	}
	// Read exactly the capability frame, leaving any pipelined TLS/HTTP2 bytes
	// untouched. Invalid input and tokens never appear in diagnostics or errors.
	want := tunnelHandshakePrefix + f.token + "\n"
	return subtle.ConstantTimeCompare(received[:], []byte(want)) == 1
}

func (f *forwarder) forward(ctx context.Context, peer net.Conn) {
	network := "tcp4"
	var header string
	if f.raw {
		network = "tcp"
	} else {
		var err error
		header, err = proxyHeader(peer.RemoteAddr(), peer.LocalAddr())
		if err != nil {
			return
		}
	}
	// tsnet's Dial can wait for login or an offline peer. Bound the attempt,
	// but keep the established stream alive for the lifetime of the listener.
	dialCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	backend, err := f.dial(dialCtx, network, f.target)
	cancel()
	if err != nil || backend == nil {
		if backend != nil {
			backend.Close()
		}
		return
	}
	if !f.track(backend) {
		return
	}
	defer f.release(backend)
	if !f.raw {
		if err := backend.SetWriteDeadline(time.Now().Add(backendTimeout)); err != nil {
			return
		}
		if n, err := io.WriteString(backend, header); err != nil || n != len(header) {
			return
		}
		if err := backend.SetWriteDeadline(time.Time{}); err != nil {
			return
		}
	}
	copyBoth(peer, backend)
}

func copyBoth(a, b net.Conn) {
	copyOne := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		if err == nil {
			// Propagate FIN without dropping the response to a half-closed
			// request. Both tsnet's TCP connection and net.TCPConn support it.
			if conn, ok := dst.(interface{ CloseWrite() error }); ok {
				if conn.CloseWrite() == nil {
					return
				}
			}
		}
		// Closing both also releases the other copy on errors or when an
		// injected/non-TCP connection cannot represent a half-close.
		a.Close()
		b.Close()
	}
	done := make(chan struct{})
	go func() { copyOne(b, a); close(done) }()
	copyOne(a, b)
	<-done
}
