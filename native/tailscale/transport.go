package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"

	"tailscale.com/net/tsaddr"
	"tailscale.com/util/dnsname"
)

const (
	maxTunnels      = 32
	maxPublications = 16
)

type tunnelResult struct {
	ID      string `json:"id"`
	Address string `json:"address"`
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
	id     string
	port   int
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

// tcpTransport owns raw listeners, independent of the HTTP/PROXY listener. The
// maps include pending allocations and closing bridges, bounding both. No dial,
// listen, or copy error is logged or returned as arbitrary backend text.
type tcpTransport struct {
	ctx        context.Context
	dial       func(context.Context, string, string) (net.Conn, error)
	listenPort func(int) (net.Listener, error)
	listen     func(context.Context) (net.Listener, error)
	slots      chan struct{}

	mu           sync.Mutex
	closed       bool
	sequence     uint64
	tunnels      map[string]*tcpBridge
	publications map[int]*tcpBridge
}

func newTCPTransport(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error), listenPort func(int) (net.Listener, error)) *tcpTransport {
	return &tcpTransport{
		ctx: ctx, dial: dial, listenPort: listenPort,
		listen: func(ctx context.Context) (net.Listener, error) {
			return (&net.ListenConfig{}).Listen(ctx, "tcp4", "127.0.0.1:0")
		},
		slots:   make(chan struct{}, maxForwardConnections),
		tunnels: make(map[string]*tcpBridge), publications: make(map[int]*tcpBridge),
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
	b := &tcpBridge{port: port, ctx: bridgeCtx, cancel: cancel, done: make(chan struct{})}
	if port == 0 {
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
	f := newForwarder(listener, target)
	f.raw = true
	f.slots = m.slots
	if b.port == 0 {
		f.dial = m.dial
	}
	go func() {
		// serve closes the listener and all tracked sockets, including on an
		// unexpected Accept failure, before releasing this allocation's slot.
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
		return response{ID: req.ID, Result: tunnelResult{ID: b.id, Address: listener.Addr().String()}}
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
