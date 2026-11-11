package network

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

const proxyLimit = 128

type proxyIngress struct {
	net.Listener
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	closed bool
	conns  map[*proxyConn]struct{}
	slots  chan struct{}
	ready  chan net.Conn
	wg     sync.WaitGroup
}

type proxyConn struct {
	net.Conn
	reader *bufio.Reader
	peer   string
	owner  *proxyIngress
	once   sync.Once
	err    error
}

func (c *proxyConn) Read(b []byte) (int, error) { return c.reader.Read(b) }
func (c *proxyConn) Close() error {
	c.once.Do(func() {
		c.err = c.Conn.Close()
		c.owner.mu.Lock()
		delete(c.owner.conns, c)
		c.owner.mu.Unlock()
		<-c.owner.slots
	})
	return c.err
}

func newProxyIngress() (*proxyIngress, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("listener_failed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &proxyIngress{Listener: listener, ctx: ctx, cancel: cancel, conns: make(map[*proxyConn]struct{}), slots: make(chan struct{}, proxyLimit), ready: make(chan net.Conn, proxyLimit)}
	p.wg.Add(1)
	go p.run()
	return p, nil
}

func (p *proxyIngress) run() {
	defer p.wg.Done()
	for {
		conn, err := p.Listener.Accept()
		if err != nil {
			p.cancel()
			return
		}
		select {
		case p.slots <- struct{}{}:
		default:
			_ = conn.Close()
			continue
		}
		owned := &proxyConn{Conn: conn, reader: bufio.NewReaderSize(conn, 4096), owner: p}
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			_ = owned.Close()
			return
		}
		p.conns[owned] = struct{}{}
		p.mu.Unlock()
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			if err := owned.readHeader(); err != nil {
				_ = owned.Close()
				return
			}
			select {
			case p.ready <- owned:
			case <-p.ctx.Done():
				_ = owned.Close()
			}
		}()
	}
}

func (c *proxyConn) readHeader() error {
	if err := c.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	var header []byte
	for len(header) < 108 {
		b, err := c.reader.ReadByte()
		if err != nil {
			return err
		}
		header = append(header, b)
		if b == '\n' {
			break
		}
	}
	line := string(header)
	if !strings.HasSuffix(line, "\r\n") {
		return errors.New("invalid_proxy_header")
	}
	fields := strings.Split(strings.TrimSuffix(line, "\r\n"), " ")
	if len(fields) != 6 || fields[0] != "PROXY" || (fields[1] != "TCP4" && fields[1] != "TCP6") {
		return errors.New("invalid_proxy_header")
	}
	source, err := netip.ParseAddr(fields[2])
	if err != nil || source.Zone() != "" || !source.IsGlobalUnicast() {
		return errors.New("invalid_proxy_header")
	}
	destination, err := netip.ParseAddr(fields[3])
	if err != nil || destination.Zone() != "" || !destination.IsGlobalUnicast() || source.Is4() != destination.Is4() || (fields[1] == "TCP4") != source.Is4() {
		return errors.New("invalid_proxy_header")
	}
	for _, raw := range fields[4:] {
		for _, ch := range raw {
			if ch < '0' || ch > '9' {
				return errors.New("invalid_proxy_header")
			}
		}
		port, err := strconv.ParseUint(raw, 10, 16)
		if err != nil || port == 0 || len(raw) > 5 {
			return errors.New("invalid_proxy_header")
		}
	}
	c.peer = net.JoinHostPort(source.Unmap().String(), fields[4])
	return c.SetReadDeadline(time.Time{})
}

func (p *proxyIngress) Accept() (net.Conn, error) {
	select {
	case <-p.ctx.Done():
		return nil, net.ErrClosed
	case conn := <-p.ready:
		return conn, nil
	}
}

func (p *proxyIngress) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		p.wg.Wait()
		return nil
	}
	p.closed = true
	conns := make([]*proxyConn, 0, len(p.conns))
	for conn := range p.conns {
		conns = append(conns, conn)
	}
	p.mu.Unlock()
	p.cancel()
	_ = p.Listener.Close()
	for _, conn := range conns {
		_ = conn.Close()
	}
	p.wg.Wait()
	return nil
}

type proxyBackend struct {
	ingress *proxyIngress
	server  *http.Server
	done    chan struct{}
}

func (s *Service) listenProxy() (*proxyBackend, error) {
	ingress, err := newProxyIngress()
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: http.HandlerFunc(s.serveTailnet), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 1 << 20,
		ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
			if peer, ok := conn.(*proxyConn); ok {
				return context.WithValue(ctx, peerKey{}, peer.peer)
			}
			return ctx
		},
	}
	p := &proxyBackend{ingress: ingress, server: server, done: make(chan struct{})}
	go func() { defer close(p.done); _ = server.Serve(ingress) }()
	return p, nil
}

func (p *proxyBackend) target() string { return "tcp://" + p.ingress.Addr().String() }
func (p *proxyBackend) close()         { _ = p.server.Close(); _ = p.ingress.Close(); <-p.done }

func (s *Service) serveTailnet(w http.ResponseWriter, r *http.Request) {
	reject := func(reason string) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":`+strconv.Quote(reason)+`}`)
	}
	peer, _ := r.Context().Value(peerKey{}).(string)
	if peer == "" {
		reject("Unknown peer address")
		return
	}
	if reason := s.access.authorize(r.Context(), s.currentNode(), r.Host, peerIP(peer)); reason != "" {
		reject(reason)
		return
	}
	path := r.URL.Path
	// Only the existing PR refresh and repository-follow actions are remotely
	// editable. A bearer token or owner cookie never opens local control,
	// secret reveal, owner bootstrap, or encrypted-owner APIs.
	pageAction := r.Method == http.MethodPost && (path == "/ui/api/pulls/refresh" || path == "/ui/api/repos") && r.Header.Get("X-Nootify-Ui") == "1"
	if (r.Method != http.MethodGet && r.Method != http.MethodHead && !pageAction) || strings.HasPrefix(path, "/v1/") || strings.HasPrefix(path, "/ui/owner") || path == "/ui/api/secure" || strings.HasSuffix(path, "/secret") || path == "/ui/api/settings/export" || path == "/ui/api/settings/reveal" {
		reject("Settings and control APIs are local-only")
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" && !(r.Method == "GET" && path == "/" && r.Header.Get("Sec-Fetch-Dest") == "document") {
		reject("Cross-site requests are not accepted")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+strings.ToLower(r.Host) {
		reject("Cross-origin requests are not accepted")
		return
	}
	r = r.WithContext(context.WithValue(r.Context(), tailnetKey{}, true))
	r.RemoteAddr = peer
	s.options.Handler.ServeHTTP(w, r)
}
