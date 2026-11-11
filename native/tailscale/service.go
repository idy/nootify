package tailscale

import (
	"context"
	"errors"
	"net"
	"os"
	"sync"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/tsnet"
)

// Config selects the private embedded node and its fixed HTTP backend. Target
// must be tcp://127.0.0.1:<port>; incoming HTTP sockets carry a PROXY v1 header
// identifying the accepted Tailnet peer, exactly as in the legacy helper.
type Config struct {
	StateDir string
	Target   string
	Hostname string
}

// Public result types preserve the legacy JSON representation.
type StatusResult = statusResult
type SelfStatus = selfStatus
type TunnelResult = tunnelResult

// Service owns one embedded Tailscale node. Start does not wait for login. Its
// parent context owns the lifetime; Close joins startup and all owned resources
// before releasing the private state lock. Create a new Service after closing.
type Service struct {
	cfg  config
	node embeddedNode

	mu         sync.Mutex
	started    bool
	closed     bool
	ctx        context.Context
	cancel     context.CancelFunc
	ready      chan struct{}
	done       chan struct{}
	initErr    error
	err        error
	dispatcher *rpcDispatcher
	calls      sync.WaitGroup
	slots      chan struct{}
	conns      map[*serviceConn]struct{}
	listeners  map[*serviceListener]struct{}
}

func NewService(cfg Config) (*Service, error) {
	if cfg.Hostname == "" {
		cfg.Hostname = "nootify"
	}
	validated, err := parseArgs([]string{"--state-dir", cfg.StateDir, "--target", cfg.Target, "--hostname", cfg.Hostname})
	if err != nil {
		return nil, err
	}
	node := &tsnetNode{server: &tsnet.Server{
		Dir: validated.stateDir, Hostname: validated.hostname,
		UserLogf: func(string, ...any) {}, Logf: func(string, ...any) {},
	}}
	return newService(validated, node), nil
}

func newService(cfg config, node embeddedNode) *Service {
	return &Service{
		cfg: cfg, node: node, ready: make(chan struct{}), done: make(chan struct{}),
		slots: make(chan struct{}, maxRPCConcurrent),
		conns: make(map[*serviceConn]struct{}), listeners: make(map[*serviceListener]struct{}),
	}
}

var embeddedEnvironmentOnce sync.Once

func prepareEmbeddedEnvironment() {
	embeddedEnvironmentOnce.Do(func() {
		// Authentication must remain interactive and use the default control
		// plane. Disable upstream log uploads, including private login URLs.
		// Do not change the unified application's global logger or stdio.
		privateEnvironment()
		logtail.Disable()
		envknob.SetNoLogsNoSupport()
	})
}

func (s *Service) Start(parent context.Context) error {
	s.mu.Lock()
	if s.closed || (s.started && s.ctx.Err() != nil) {
		s.mu.Unlock()
		return errors.New("unavailable")
	}
	if !s.started {
		s.started = true
		s.ctx, s.cancel = context.WithCancel(parent)
		go s.run()
	}
	ready := s.ready
	s.mu.Unlock()
	<-ready
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.initErr
}

// Done closes after the embedded node, sockets, handlers, and lock are closed.
func (s *Service) Done() <-chan struct{} { return s.done }

// Err reports a sanitized terminal error, such as listener_failed. Cancellation
// and an explicit Close are normal shutdowns and leave Err nil.
func (s *Service) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

func (s *Service) Close() error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		if !s.started {
			s.initErr = errors.New("unavailable")
			close(s.ready)
			close(s.done)
		} else {
			s.cancel()
		}
	}
	s.mu.Unlock()
	<-s.done
	return s.Err()
}

func (s *Service) run() {
	ctx := s.ctx
	var lock *os.File
	var nodeStarted, initialized bool
	var f *forwarder
	var transport *tcpTransport
	var forwardDone chan struct{}
	var forwardErr, terminal error
	defer func() {
		s.cancel()
		if f != nil {
			f.close()
			<-forwardDone
		}
		if transport != nil {
			transport.close()
		}
		s.mu.Lock()
		conns := make([]*serviceConn, 0, len(s.conns))
		for conn := range s.conns {
			conns = append(conns, conn)
		}
		listeners := make([]*serviceListener, 0, len(s.listeners))
		for listener := range s.listeners {
			listeners = append(listeners, listener)
		}
		s.mu.Unlock()
		for _, listener := range listeners {
			_ = listener.Close()
		}
		for _, conn := range conns {
			_ = conn.Close()
		}
		// No new call is admitted after cancellation. Wait before node.Close:
		// in particular, upstream forbids Close concurrent with Start.
		s.calls.Wait()
		if nodeStarted {
			if err := s.node.Close(); err != nil && terminal == nil {
				terminal = errors.New("close_failed")
			}
		}
		if lock != nil {
			_ = lock.Close()
		}
		s.mu.Lock()
		s.err = terminal
		if !initialized {
			s.initErr = terminal
			if s.initErr == nil {
				s.initErr = errors.New("canceled")
			}
			close(s.ready)
		}
		close(s.done)
		s.mu.Unlock()
	}()

	var err error
	lock, err = prepareStateDir(s.cfg.stateDir)
	if err != nil {
		terminal = errors.New("state_unavailable")
		if errors.Is(err, errStateLocked) {
			terminal = errors.New("state_locked")
		}
		return
	}
	if ctx.Err() != nil {
		return
	}
	prepareEmbeddedEnvironment()
	nodeStarted = true // Even a failed Start may own resources.
	if err := s.node.Start(); err != nil {
		terminal = errors.New("startup_failed")
		return
	}
	if ctx.Err() != nil {
		return
	}
	client, err := s.node.Client()
	if err != nil || client == nil {
		terminal = errors.New("client_unavailable")
		return
	}
	listener, err := s.node.Listen()
	if err != nil || listener == nil {
		if listener != nil {
			_ = listener.Close()
		}
		terminal = errors.New("listener_failed")
		return
	}
	f = newForwarder(listener, s.cfg.target)
	transport = newTCPTransport(ctx, s.node.Dial, s.node.ListenPort)
	forwardDone = make(chan struct{})
	go func() {
		forwardErr = f.serve(ctx)
		close(forwardDone)
	}()
	s.mu.Lock()
	s.dispatcher = &rpcDispatcher{
		client: client, listening: f.listening.Load,
		mutations: make(chan struct{}, 1), transport: transport,
	}
	initialized = true
	close(s.ready)
	s.mu.Unlock()

	select {
	case <-ctx.Done():
	case <-forwardDone:
		if forwardErr != nil {
			terminal = errors.New("listener_failed")
		}
	}
}

func (s *Service) begin(parent context.Context) (context.Context, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dispatcher == nil || s.closed || s.ctx.Err() != nil {
		return nil, nil, errors.New("unavailable")
	}
	select {
	case s.slots <- struct{}{}:
	default:
		return nil, nil, errors.New("busy")
	}
	s.calls.Add(1)
	ctx, cancel := context.WithTimeout(parent, rpcTimeout)
	stop := context.AfterFunc(s.ctx, cancel)
	return ctx, func() { stop(); cancel(); <-s.slots; s.calls.Done() }, nil
}

func (s *Service) call(parent context.Context, req request) (any, error) {
	ctx, finish, err := s.begin(parent)
	if err != nil {
		return nil, err
	}
	defer finish()
	reply := s.dispatcher.dispatch(ctx, req)
	if reply.Error != "" {
		return nil, errors.New(reply.Error)
	}
	return reply.Result, nil
}

func (s *Service) Status(ctx context.Context) (StatusResult, error) {
	result, err := s.call(ctx, request{Method: "status"})
	if err != nil {
		return StatusResult{}, err
	}
	return result.(statusResult), nil
}

func (s *Service) Login(ctx context.Context) error {
	_, err := s.call(ctx, request{Method: "login"})
	return err
}

func (s *Service) Logout(ctx context.Context) error {
	_, err := s.call(ctx, request{Method: "logout"})
	return err
}

func (s *Service) WhoIs(ctx context.Context, ip string) (*apitype.WhoIsResponse, error) {
	result, err := s.call(ctx, request{Method: "whois", IP: ip})
	if err != nil {
		return nil, err
	}
	return result.(*apitype.WhoIsResponse), nil
}

func (s *Service) Tunnel(ctx context.Context, address string) (TunnelResult, error) {
	result, err := s.call(ctx, request{Method: "tunnel", Address: address})
	if err != nil {
		return TunnelResult{}, err
	}
	return result.(tunnelResult), nil
}

func (s *Service) CloseTunnel(ctx context.Context, id string) error {
	_, err := s.call(ctx, request{Method: "close_tunnel", TunnelID: id})
	return err
}

func (s *Service) Publish(ctx context.Context, port int, target string) error {
	_, err := s.call(ctx, request{Method: "publish", Port: port, Target: target})
	return err
}

func (s *Service) Unpublish(ctx context.Context, port int) error {
	_, err := s.call(ctx, request{Method: "unpublish", Port: port})
	return err
}

// Dial uses only the embedded encrypted stack and refuses host, public, subnet,
// and service destinations. It is suitable for core.Core.SetTailnetDialer.
func (s *Service) Dial(parent context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" {
		return nil, errors.New("invalid_network")
	}
	address, err := validateTailnetAddress(address)
	if err != nil {
		return nil, err
	}
	ctx, finish, err := s.begin(parent)
	if err != nil {
		return nil, err
	}
	defer finish()
	return s.dispatcher.transport.dialDirect(ctx, address)
}

// Listen binds a raw TCP port on the embedded node (port 80 belongs to HTTP).
// Accept failures retry with the existing publication backoff. The service owns
// both the listener and every accepted connection until they are closed.
func (s *Service) Listen(port int) (net.Listener, error) {
	if !publicationPort(port) {
		return nil, errors.New("invalid_port")
	}
	ctx, finish, err := s.begin(context.Background())
	if err != nil {
		return nil, err
	}
	defer finish()
	transport := s.dispatcher.transport
	b, err := transport.reserve(ctx, port)
	if err != nil {
		return nil, errors.New(contextError(err, err.Error()))
	}
	listener, err := s.node.ListenPort(port)
	if err != nil || listener == nil {
		transport.finish(b)
		if listener != nil {
			_ = listener.Close()
		}
		return nil, errors.New(contextError(err, "listener_failed"))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || s.ctx.Err() != nil || s.closed {
		_ = listener.Close()
		transport.finish(b)
		return nil, errors.New("canceled")
	}
	owned := &serviceListener{Listener: newPublicationListener(b.ctx, listener, func() (net.Listener, error) {
		return s.node.ListenPort(port)
	}, waitPublicationRetry), service: s, limit: b.limit, release: func() { transport.finish(b) }, conns: make(map[*serviceConn]struct{})}
	s.listeners[owned] = struct{}{}
	context.AfterFunc(b.ctx, func() { _ = owned.Close() })
	return owned, nil
}

type serviceConn struct {
	net.Conn
	service  *Service
	listener *serviceListener
	once     sync.Once
	release  func()
	closeErr error
}

func (c *serviceConn) Close() error {
	c.once.Do(func() {
		c.service.mu.Lock()
		delete(c.service.conns, c)
		if c.listener != nil {
			delete(c.listener.conns, c)
		}
		c.service.mu.Unlock()
		c.closeErr = c.Conn.Close()
		c.release()
	})
	return c.closeErr
}

func (c *serviceConn) CloseWrite() error {
	if conn, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return conn.CloseWrite()
	}
	return errors.New("half_close_unsupported")
}

func (c *serviceConn) CloseRead() error {
	if conn, ok := c.Conn.(interface{ CloseRead() error }); ok {
		return conn.CloseRead()
	}
	return errors.New("half_close_unsupported")
}

type serviceListener struct {
	net.Listener
	service  *Service
	limit    connectionLimit
	once     sync.Once
	closed   bool // protected by service.mu
	conns    map[*serviceConn]struct{}
	release  func()
	closeErr error
}

func (l *serviceListener) Close() error {
	l.once.Do(func() {
		l.service.mu.Lock()
		l.closed = true
		delete(l.service.listeners, l)
		conns := make([]*serviceConn, 0, len(l.conns))
		for conn := range l.conns {
			conns = append(conns, conn)
		}
		l.service.mu.Unlock()
		l.closeErr = l.Listener.Close()
		for _, conn := range conns {
			_ = conn.Close()
		}
		l.release()
	})
	return l.closeErr
}

func (l *serviceListener) Accept() (net.Conn, error) {
	l.service.mu.Lock()
	if l.closed || l.service.ctx.Err() != nil || l.service.closed {
		l.service.mu.Unlock()
		return nil, net.ErrClosed
	}
	l.service.calls.Add(1)
	l.service.mu.Unlock()
	defer l.service.calls.Done()
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, net.ErrClosed
		}
		release := l.limit.acquire()
		if release == nil {
			_ = conn.Close()
			continue
		}
		l.service.mu.Lock()
		if l.closed || l.service.ctx.Err() != nil || l.service.closed {
			l.service.mu.Unlock()
			_ = conn.Close()
			release()
			return nil, net.ErrClosed
		}
		owned := &serviceConn{Conn: conn, service: l.service, listener: l, release: release}
		l.service.conns[owned] = struct{}{}
		l.conns[owned] = struct{}{}
		l.service.mu.Unlock()
		return owned, nil
	}
}
