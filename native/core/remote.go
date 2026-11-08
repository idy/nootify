package main

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/netip"
	"strings"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type remoteServer struct {
	pb.UnimplementedNotificationCoreServer
	core     *Core
	server   *grpc.Server
	listener net.Listener
	token    string
}

func (s *remoteServer) stop() { s.server.Stop(); _ = s.listener.Close() }
func (c *Core) startServer(r RemoteConfig) error {
	if err := validateRemote(r); err != nil {
		return err
	}
	listener, err := net.Listen("tcp", r.Listen)
	if err != nil {
		return err
	}
	s := &remoteServer{core: c, listener: listener, token: r.Token}
	options := []grpc.ServerOption{grpc.MaxRecvMsgSize(2 * maxPayload), grpc.MaxSendMsgSize(2 * maxPayload), grpc.MaxConcurrentStreams(128), grpc.UnaryInterceptor(s.unaryAuth), grpc.StreamInterceptor(s.streamAuth)}
	if r.CertFile != "" {
		cert, err := tls.LoadX509KeyPair(r.CertFile, r.KeyFile)
		if err != nil {
			listener.Close()
			return err
		}
		options = append(options, grpc.Creds(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}})))
	}
	s.server = grpc.NewServer(options...)
	pb.RegisterNotificationCoreServer(s.server, s)
	c.mu.Lock()
	c.server = s
	c.mu.Unlock()
	go func() {
		if err := s.server.Serve(listener); err != nil && c.ctx.Err() == nil {
			c.log("remote_listener_stopped", "", "")
		}
	}()
	return nil
}
func (s *remoteServer) auth(ctx context.Context) error {
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte("Bearer "+s.token)) != 1 {
		return status.Error(codes.Unauthenticated, "authentication required")
	}
	node := md.Get("nootify-node-id")
	if len(node) != 1 || node[0] == "" || len(node[0]) > 128 {
		return status.Error(codes.Unauthenticated, "node identity required")
	}
	return nil
}
func (s *remoteServer) unaryAuth(ctx context.Context, req any, _ *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
	if err := s.auth(ctx); err != nil {
		return nil, err
	}
	return next(ctx, req)
}
func (s *remoteServer) streamAuth(srv any, stream grpc.ServerStream, _ *grpc.StreamServerInfo, next grpc.StreamHandler) error {
	if err := s.auth(stream.Context()); err != nil {
		return err
	}
	return next(srv, stream)
}
func (s *remoteServer) Call(ctx context.Context, in *pb.Command) (*pb.Result, error) {
	if len(in.ParamsJson) > maxPayload {
		return nil, status.Error(codes.ResourceExhausted, "request exceeds limit")
	}
	if len(in.VisitedNodes) >= 16 || contains(in.VisitedNodes, s.core.node()) {
		return nil, status.Error(codes.FailedPrecondition, "command routing loop")
	}
	md, _ := metadata.FromIncomingContext(ctx)
	peer := md.Get("nootify-node-id")[0]
	if len(in.VisitedNodes) == 0 || in.VisitedNodes[len(in.VisitedNodes)-1] != peer {
		return nil, status.Error(codes.PermissionDenied, "invalid command route")
	}
	route := append(append([]string{}, in.VisitedNodes...), s.core.node())
	ctx = context.WithValue(ctx, commandRouteKey{}, route)
	result, err := s.core.Handle(ctx, in.Method, in.ParamsJson, false)
	if err != nil {
		e := publicError(err)
		return &pb.Result{ErrorCode: e.Code, ErrorMessage: e.Message}, nil
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, status.Error(codes.Internal, "response encoding failed")
	}
	return &pb.Result{ResultJson: raw}, nil
}
func eventFrame(e Event) *pb.SubscriptionFrame {
	s, _ := json.Marshal(e.Session)
	m, _ := json.Marshal(e.Message)
	c, _ := json.Marshal(e.Content)
	return &pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Event{Event: &pb.Event{EventId: e.ID, SessionJson: s, MessageJson: m, ContentJson: c, VisitedNodes: e.Visited, HopsRemaining: e.Hops, SenderId: e.SenderID, ChatId: e.ChatID}}}
}
func parseEvent(e *pb.Event) (Event, error) {
	v := Event{ID: e.EventId, Visited: e.VisitedNodes, Hops: e.HopsRemaining, SenderID: e.SenderId, ChatID: e.ChatId}
	if err := json.Unmarshal(e.SessionJson, &v.Session); err != nil {
		return v, err
	}
	if err := json.Unmarshal(e.MessageJson, &v.Message); err != nil {
		return v, err
	}
	err := json.Unmarshal(e.ContentJson, &v.Content)
	return v, err
}
func (s *remoteServer) Subscribe(stream grpc.BidiStreamingServer[pb.SubscriptionFrame, pb.SubscriptionFrame]) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	hello := first.GetHello()
	if hello == nil {
		return status.Error(codes.InvalidArgument, "first frame must identify the subscriber")
	}
	md, _ := metadata.FromIncomingContext(stream.Context())
	if hello.NodeId != md.Get("nootify-node-id")[0] {
		return status.Error(codes.PermissionDenied, "subscriber identity does not match authenticated connection")
	}
	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()
	sub, err := s.core.Subscribe(ctx, hello.NodeId, hello.Name)
	if err != nil {
		return status.Error(codes.InvalidArgument, publicError(err).Message)
	}
	defer sub.Close()
	if err = stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: s.core.node()}}}); err != nil {
		return err
	}
	errors := make(chan error, 2)
	go func() {
		for {
			event, err := sub.Next()
			if err != nil {
				errors <- err
				return
			}
			if err = stream.Send(eventFrame(event)); err != nil {
				errors <- err
				return
			}
		}
	}()
	go func() {
		for {
			frame, err := stream.Recv()
			if err != nil {
				errors <- err
				return
			}
			confirm := frame.GetConfirmation()
			if confirm == nil {
				errors <- status.Error(codes.InvalidArgument, "expected confirmation")
				return
			}
			if err = sub.Confirm(confirm.EventId); err != nil {
				errors <- status.Error(codes.ResourceExhausted, "confirmation could not be persisted")
				return
			}
		}
	}()
	return <-errors
}

type remoteProvider struct {
	core      *Core
	config    ProviderConfig
	conn      *grpc.ClientConn
	client    pb.NotificationCoreClient
	ctx       context.Context
	cancel    context.CancelFunc
	initErr   error
	retryWait func(context.Context, time.Duration) error
}

func newRemoteProvider(c *Core, p ProviderConfig) *remoteProvider {
	ctx, cancel := context.WithCancel(c.ctx)
	r := &remoteProvider{core: c, config: p, ctx: ctx, cancel: cancel}
	var tc credentials.TransportCredentials = insecure.NewCredentials()
	if p.TLS {
		host, _, _ := net.SplitHostPort(p.Address)
		serverName := p.ServerName
		if serverName == "" {
			serverName = host
		}
		tc = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, ServerName: serverName})
	}
	r.conn, r.initErr = grpc.NewClient("passthrough:///"+p.Address, grpc.WithTransportCredentials(tc), grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return c.dial(ctx, p.Address) }), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(2*maxPayload), grpc.MaxCallSendMsgSize(2*maxPayload)))
	if r.initErr == nil {
		r.client = pb.NewNotificationCoreClient(r.conn)
	}
	return r
}
func (p *remoteProvider) auth(ctx context.Context) context.Context {
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+p.config.Token, "nootify-node-id", p.core.node())
}
func (p *remoteProvider) Subscribe(ctx context.Context, receive EventHandler) error {
	if receive == nil {
		return fault("invalid_argument", "event handler is required")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(p.ctx, cancel)
	defer stop()
	delay := 100 * time.Millisecond
	for ctx.Err() == nil && p.ctx.Err() == nil {
		_ = p.consume(ctx, receive, func() { delay = 100 * time.Millisecond })
		if ctx.Err() != nil || p.ctx.Err() != nil {
			break
		}
		p.core.setStatus(p.config.ID, "reconnecting")
		wait := p.retryWait
		if wait == nil {
			wait = waitForReconnect
		}
		if err := wait(ctx, delay); err != nil {
			return err
		}
		delay = min(delay*2, 10*time.Second)
	}
	return ctx.Err()
}
func waitForReconnect(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (p *remoteProvider) consume(ctx context.Context, receive EventHandler, connected func()) error {
	if p.initErr != nil {
		return p.initErr
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := p.client.Subscribe(p.auth(ctx))
	if err != nil {
		return err
	}
	if err = stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: p.core.node(), Name: p.config.Name}}}); err != nil {
		return err
	}
	frame, err := stream.Recv()
	if err != nil {
		return err
	}
	if frame.GetHello() == nil || frame.GetHello().NodeId == p.core.node() {
		return fault("loop", "remote subscription loops to this node")
	}
	p.core.setStatus(p.config.ID, "connected")
	connected()
	for {
		frame, err = stream.Recv()
		if err != nil {
			return err
		}
		if frame.GetEvent() == nil {
			return fault("invalid_argument", "expected remote event")
		}
		event, err := parseEvent(frame.GetEvent())
		if err != nil {
			return err
		}
		if err = receive(ctx, event); err != nil {
			return err
		}
		if err = stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: event.ID}}}); err != nil {
			return err
		}
	}
}
func (p *remoteProvider) Close() error {
	p.cancel()
	if p.conn != nil {
		return p.conn.Close()
	}
	return nil
}
func (p *remoteProvider) call(ctx context.Context, method string, params any, out any) error {
	if p.initErr != nil {
		return fault("unavailable", "remote connection could not be created")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	route := append([]string{}, commandRoute(ctx)...)
	node := p.core.node()
	if len(route) == 0 || route[len(route)-1] != node {
		route = append(route, node)
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	result, err := p.client.Call(p.auth(ctx), &pb.Command{Method: method, ParamsJson: raw, VisitedNodes: route})
	if err != nil {
		return fault("unavailable", "remote operation failed")
	}
	if result.ErrorCode != "" {
		return decodeOperationError(result.ErrorCode, result.ErrorMessage)
	}
	if out != nil {
		return json.Unmarshal(result.ResultJson, out)
	}
	return nil
}
func (p *remoteProvider) Ensure(ctx context.Context, s Session) (Binding, error) {
	var b Binding
	err := p.call(ctx, "session.ensure", map[string]any{"session": s, "automatic": automaticEnsure(ctx)}, &b)
	return b, err
}
func (p *remoteProvider) Metadata(ctx context.Context, b Binding, m map[string]any, set bool) (map[string]any, error) {
	method := "session.metadata.get"
	if set {
		method = "session.metadata.set"
	}
	var out map[string]any
	err := p.call(ctx, method, map[string]any{"session": b.Session, "metadata": m}, &out)
	return out, err
}
func (p *remoteProvider) Delete(ctx context.Context, b Binding) error {
	return p.call(ctx, "session.delete", map[string]any{"session": b.Session}, nil)
}
func (p *remoteProvider) Send(ctx context.Context, b Binding, c Content, request string) (SendResult, error) {
	var out SendResult
	err := p.call(ctx, "message.send", map[string]any{"session": b.Session, "content": c, "request_id": request}, &out)
	if err == nil {
		err = p.core.store.Update(func(d *State) error { remember(d, out.Message, p.config.ID); return nil })
	}
	return out, err
}
func (p *remoteProvider) Reply(ctx context.Context, m MessageRef, c Content, request string) (SendResult, error) {
	var out SendResult
	err := p.call(ctx, "message.reply", map[string]any{"message": m, "content": c, "request_id": request}, &out)
	if err == nil {
		err = p.core.store.Update(func(d *State) error { remember(d, out.Message, p.config.ID); return nil })
	}
	return out, err
}
func (p *remoteProvider) Ack(ctx context.Context, m MessageRef) error {
	return p.call(ctx, "message.ack", map[string]any{"message": m}, nil)
}

type dialResult struct {
	Address string
	Error   string
}

func isTailnet(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if strings.HasSuffix(host, ".ts.net") {
		return true
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)
}
func (c *Core) dial(ctx context.Context, address string) (net.Conn, error) {
	target := address
	if c.store.Snapshot().Tailnet && isTailnet(address) {
		id := uid()
		ch := make(chan dialResult, 1)
		c.dialMu.Lock()
		if len(c.dials) >= 32 {
			c.dialMu.Unlock()
			return nil, fault("resource_exhausted", "too many pending tunnels")
		}
		c.dials[id] = ch
		c.dialMu.Unlock()
		defer func() { c.dialMu.Lock(); delete(c.dials, id); c.dialMu.Unlock() }()
		if c.emit == nil {
			return nil, fault("unavailable", "tunnel bridge is unavailable")
		}
		if err := c.emit("dial", map[string]any{"request_id": id, "address": address}); err != nil {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-c.ctx.Done():
			return nil, c.ctx.Err()
		case result := <-ch:
			if result.Error != "" {
				return nil, fault("unavailable", "embedded tunnel failed")
			}
			target = result.Address
		}
	}
	return (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", target)
}
func (c *Core) completeDial(id, address, msg string) error {
	if msg == "" {
		host, _, err := net.SplitHostPort(address)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || !ip.IsLoopback() {
			return fault("invalid_argument", "tunnel endpoint must be numeric loopback host:port")
		}
		if err = validAddress(address); err != nil {
			return err
		}
	}
	c.dialMu.Lock()
	defer c.dialMu.Unlock()
	ch := c.dials[id]
	if ch == nil {
		return fault("not_found", "dial request does not exist")
	}
	select {
	case ch <- dialResult{address, msg}:
		return nil
	default:
		return fault("conflict", "dial request already completed")
	}
}
