package tailscale

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/net/tsaddr"
	"tailscale.com/util/dnsname"
)

const (
	maxTunnels      = 32
	maxPublications = 16

	// Two slots per allocation cannot be consumed by other bridges. A bridge
	// may borrow up to fourteen more from the shared pool; all 48 allocations
	// together still admit at most 128 raw connections (96 reserved + 32 burst).
	maxRawConnections         = 128
	reservedBridgeConnections = 2
	maxBridgeConnections      = 16
	sharedBurstConnections    = maxRawConnections - (maxTunnels+maxPublications)*reservedBridgeConnections

	// Pending local authentication never borrows authenticated bridge capacity.
	// Per-tunnel admission isolates unrelated tunnels and bounds the helper to
	// 64 pending handshakes across its 32 possible tunnel allocations.
	maxPendingTunnelHandshakes = 2
	tunnelHandshakeTimeout     = 3 * time.Second
	tunnelHandshakePrefix      = "NOOTIFY-TUNNEL/1 "
	tunnelTokenBytes           = 32

	publicationRetryMin = 100 * time.Millisecond
	publicationRetryMax = 5 * time.Second
)

type tunnelResult struct {
	ID      string `json:"id"`
	Address string `json:"address"`
	Network string `json:"network"`
	Token   string `json:"token"` // capability passed only over private stdio IPC
}

type publishResult struct {
	Port int `json:"port"`
}

// Only node IPs and fully qualified MagicDNS names may be reached. In particular,
// this API must not become a proxy to localhost, public IPs, or subnet routes.
func validateTailnetAddress(raw string) (string, error) {
	host, port, err := net.SplitHostPort(raw)
	if err != nil || host == "" || port == "" {
		return "", errors.New("invalid_address")
	}
	for _, ch := range port {
		if ch < '0' || ch > '9' {
			return "", errors.New("invalid_address")
		}
	}
	n, err := strconv.ParseUint(port, 10, 16)
	if err != nil || n == 0 {
		return "", errors.New("invalid_address")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if ip.Zone() != "" {
			return "", errors.New("invalid_address")
		}
		ip = ip.Unmap()
		if !tsaddr.IsTailscaleIP(ip) || tsaddr.TailscaleViaRange().Contains(ip) ||
			ip == tsaddr.TailscaleServiceIP() || ip == tsaddr.TailscaleServiceIPv6() {
			return "", errors.New("invalid_address")
		}
		host = ip.String()
	} else {
		host = strings.TrimSuffix(strings.ToLower(host), ".")
		if strings.HasPrefix(raw, "[") || len(host) > 253 || !strings.HasSuffix(host, ".ts.net") {
			return "", errors.New("invalid_address")
		}
		for _, label := range strings.Split(host, ".") {
			if dnsname.ValidLabel(label) != nil {
				return "", errors.New("invalid_address")
			}
		}
	}
	return net.JoinHostPort(host, strconv.FormatUint(n, 10)), nil
}

func validateLoopbackAddress(raw string) (string, error) {
	addr, err := netip.ParseAddrPort(raw)
	if err != nil || addr.Port() == 0 || addr.Addr().Zone() != "" || !addr.Addr().Unmap().IsLoopback() {
		return "", errors.New("invalid_target")
	}
	return netip.AddrPortFrom(addr.Addr().Unmap(), addr.Port()).String(), nil
}

func publicationPort(port int) bool { return port > 0 && port <= 65535 && port != 80 }

type tcpBridge struct {
	id      string
	port    int
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	limit   connectionLimit
	token   string
	pending chan struct{}
}

// A publication belongs to its bridge until unpublish or service shutdown. A
// failed Accept must not silently remove it while the parent still caches it.
// Rebinding the listener here also leaves established forwarding streams alive.
type publicationListener struct {
	ctx    context.Context
	cancel context.CancelFunc
	addr   net.Addr
	listen func() (net.Listener, error)
	wait   func(context.Context, time.Duration) bool

	mu       sync.Mutex
	listener net.Listener
}

func newPublicationListener(ctx context.Context, listener net.Listener, listen func() (net.Listener, error), wait func(context.Context, time.Duration) bool) *publicationListener {
	ctx, cancel := context.WithCancel(ctx)
	return &publicationListener{ctx: ctx, cancel: cancel, addr: listener.Addr(), listen: listen, wait: wait, listener: listener}
}

func waitPublicationRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return ctx.Err() == nil
	case <-ctx.Done():
		return false
	}
}

func (l *publicationListener) Accept() (net.Conn, error) {
	delay := publicationRetryMin
	for {
		l.mu.Lock()
		listener := l.listener
		l.mu.Unlock()
		if l.ctx.Err() != nil {
			return nil, net.ErrClosed
		}
		if listener != nil {
			conn, err := listener.Accept()
			if err == nil {
				return conn, nil
			}
			listener.Close()
			l.mu.Lock()
			l.listener = nil
			l.mu.Unlock()
		}
		if !l.wait(l.ctx, delay) || l.ctx.Err() != nil {
			return nil, net.ErrClosed
		}
		listener, err := l.listen()
		if err != nil || listener == nil {
			if listener != nil {
				listener.Close()
			}
		} else {
			l.mu.Lock()
			if l.ctx.Err() != nil {
				l.mu.Unlock()
				listener.Close()
				return nil, net.ErrClosed
			}
			l.listener = listener
			l.mu.Unlock()
		}
		// Reset only after accepting a connection. A listener that repeatedly
		// binds successfully but fails Accept must not spin at the minimum.
		delay = min(2*delay, publicationRetryMax)
	}
}

func (l *publicationListener) Close() error {
	l.cancel()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.listener != nil {
		return l.listener.Close()
	}
	return nil
}

func (l *publicationListener) Addr() net.Addr { return l.addr }

// tcpTransport owns raw listeners, independent of the HTTP/PROXY listener. The
// maps include pending allocations and closing bridges, bounding both. No dial,
// listen, or copy error is logged or returned as arbitrary backend text.
type tcpTransport struct {
	ctx         context.Context
	dial        func(context.Context, string, string) (net.Conn, error)
	listenPort  func(int) (net.Listener, error)
	listen      func(context.Context) (net.Listener, error)
	retryWait   func(context.Context, time.Duration) bool
	sharedSlots chan struct{}

	mu           sync.Mutex
	closed       bool
	sequence     uint64
	tunnels      map[string]*tcpBridge
	publications map[int]*tcpBridge
}

func newTCPTransport(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error), listenPort func(int) (net.Listener, error)) *tcpTransport {
	return &tcpTransport{
		ctx: ctx, dial: dial, listenPort: listenPort,
		listen:      listenLocalTunnel,
		retryWait:   waitPublicationRetry,
		sharedSlots: make(chan struct{}, sharedBurstConnections),
		tunnels:     make(map[string]*tcpBridge), publications: make(map[int]*tcpBridge),
	}
}

func (m *tcpTransport) reserve(ctx context.Context, port int) (*tcpBridge, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if m.closed || m.ctx.Err() != nil {
		return nil, context.Canceled
	}
	if port == 0 {
		if len(m.tunnels) >= maxTunnels {
			return nil, errors.New("tunnel_limit")
		}
	} else {
		if _, exists := m.publications[port]; exists {
			return nil, errors.New("port_in_use")
		}
		if len(m.publications) >= maxPublications {
			return nil, errors.New("publication_limit")
		}
	}
	bridgeCtx, cancel := context.WithCancel(m.ctx)
	b := &tcpBridge{
		port: port, ctx: bridgeCtx, cancel: cancel, done: make(chan struct{}),
		limit: connectionLimit{
			reserved: make(chan struct{}, reservedBridgeConnections),
			burst:    make(chan struct{}, maxBridgeConnections-reservedBridgeConnections),
			shared:   m.sharedSlots,
		},
	}
	if port == 0 {
		var token [tunnelTokenBytes]byte
		rand.Read(token[:])
		b.token = hex.EncodeToString(token[:])
		b.pending = make(chan struct{}, maxPendingTunnelHandshakes)
		m.sequence++
		b.id = strconv.FormatUint(m.sequence, 10)
		m.tunnels[b.id] = b
	} else {
		m.publications[port] = b
	}
	return b, nil
}

func (m *tcpTransport) finish(b *tcpBridge) {
	b.cancel()
	m.mu.Lock()
	defer m.mu.Unlock()
	if b.port == 0 {
		delete(m.tunnels, b.id)
	} else {
		delete(m.publications, b.port)
	}
	close(b.done)
}

// dialDirect reserves the same bounded tunnel capacity as the compatibility
// bridge, but returns an encrypted embedded socket without a local IPC hop.
func (m *tcpTransport) dialDirect(ctx context.Context, address string) (net.Conn, error) {
	b, err := m.reserve(ctx, 0)
	if err != nil {
		return nil, errors.New(contextError(err, err.Error()))
	}
	dialCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(b.ctx, cancel)
	conn, err := m.dial(dialCtx, "tcp", address)
	stop()
	canceled := dialCtx.Err() != nil || b.ctx.Err() != nil
	cancel()
	if err != nil || conn == nil || canceled {
		if conn != nil {
			_ = conn.Close()
		}
		m.finish(b)
		if canceled {
			return nil, errors.New("canceled")
		}
		return nil, errors.New(contextError(err, "dial_failed"))
	}
	owned := &directTunnelConn{Conn: conn, release: func() { m.finish(b) }}
	context.AfterFunc(b.ctx, func() { _ = owned.Close() })
	return owned, nil
}

type directTunnelConn struct {
	net.Conn
	once     sync.Once
	release  func()
	closeErr error
}

func (c *directTunnelConn) Close() error {
	c.once.Do(func() { c.closeErr = c.Conn.Close(); c.release() })
	return c.closeErr
}

func (c *directTunnelConn) CloseWrite() error {
	if conn, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return conn.CloseWrite()
	}
	return errors.New("half_close_unsupported")
}

func (c *directTunnelConn) CloseRead() error {
	if conn, ok := c.Conn.(interface{ CloseRead() error }); ok {
		return conn.CloseRead()
	}
	return errors.New("half_close_unsupported")
}

// The RPC context only owns allocation. Established bridges belong to the
// service context and survive the RPC's timeout and its deferred cancellation.
func (m *tcpTransport) start(ctx context.Context, b *tcpBridge, target string) (net.Listener, error) {
	stop := context.AfterFunc(ctx, b.cancel)
	var listener net.Listener
	var err error
	if b.port == 0 {
		listener, err = m.listen(b.ctx)
	} else {
		listener, err = m.listenPort(b.port)
	}
	stop()
	if ctx.Err() != nil {
		err = ctx.Err()
	} else if b.ctx.Err() != nil {
		err = b.ctx.Err()
	}
	if err != nil || listener == nil {
		if listener != nil {
			listener.Close()
		}
		m.finish(b)
		return nil, errors.New(contextError(err, "listener_failed"))
	}
	if b.port != 0 {
		listener = newPublicationListener(b.ctx, listener, func() (net.Listener, error) {
			return m.listenPort(b.port)
		}, m.retryWait)
	}
	f := newForwarder(listener, target)
	f.raw = true
	f.limit = b.limit
	if b.port == 0 {
		f.dial = m.dial
		f.token = b.token
		f.pending = b.pending
	}
	go func() {
		// Publications recover Accept failures without ending serve. Cancellation
		// closes their current listener and every tracked socket before releasing
		// the reservation; tunnel listener failures still end their allocation.
		_ = f.serve(b.ctx)
		m.finish(b)
	}()
	return listener, nil
}

func (m *tcpTransport) dispatch(ctx context.Context, req request) response {
	switch req.Method {
	case "tunnel":
		address, err := validateTailnetAddress(req.Address)
		if err != nil {
			return failure(req.ID, "invalid_address")
		}
		b, err := m.reserve(ctx, 0)
		if err != nil {
			return failure(req.ID, contextError(err, err.Error()))
		}
		listener, err := m.start(ctx, b, address)
		if err != nil {
			return failure(req.ID, err.Error())
		}
		return response{ID: req.ID, Result: tunnelResult{ID: b.id, Address: listener.Addr().String(), Network: localTunnelNetwork, Token: b.token}}
	case "publish":
		if !publicationPort(req.Port) {
			return failure(req.ID, "invalid_port")
		}
		target, err := validateLoopbackAddress(req.Target)
		if err != nil {
			return failure(req.ID, "invalid_target")
		}
		b, err := m.reserve(ctx, req.Port)
		if err != nil {
			return failure(req.ID, contextError(err, err.Error()))
		}
		if _, err := m.start(ctx, b, target); err != nil {
			return failure(req.ID, err.Error())
		}
		return response{ID: req.ID, Result: publishResult{Port: req.Port}}
	case "close_tunnel", "unpublish":
		m.mu.Lock()
		var b *tcpBridge
		if req.Method == "close_tunnel" {
			if req.TunnelID == "" || len(req.TunnelID) > 64 {
				m.mu.Unlock()
				return failure(req.ID, "invalid_tunnel_id")
			}
			b = m.tunnels[req.TunnelID]
		} else {
			if !publicationPort(req.Port) {
				m.mu.Unlock()
				return failure(req.ID, "invalid_port")
			}
			b = m.publications[req.Port]
		}
		m.mu.Unlock()
		if b != nil {
			b.cancel()
			<-b.done
		}
		return response{ID: req.ID, Result: struct {
			OK bool `json:"ok"`
		}{true}}
	}
	return failure(req.ID, "unknown_method")
}

func (m *tcpTransport) close() {
	m.mu.Lock()
	m.closed = true
	bridges := make([]*tcpBridge, 0, len(m.tunnels)+len(m.publications))
	for _, b := range m.tunnels {
		bridges = append(bridges, b)
	}
	for _, b := range m.publications {
		bridges = append(bridges, b)
	}
	m.mu.Unlock()
	for _, b := range bridges {
		b.cancel()
	}
	for _, b := range bridges {
		<-b.done
	}
}
