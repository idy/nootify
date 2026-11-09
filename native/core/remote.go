package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/tap"
)

const remoteHandshakeTimeout = 5 * time.Second
const remoteConnectionIdle = 30 * time.Second

type remoteServer struct {
	pb.UnimplementedNotificationCoreServer
	core        *Core
	server      *grpc.Server
	listener    net.Listener
	configMu    sync.RWMutex
	config      RemoteConfig
	certificate *tls.Certificate
	authContext context.Context
	revokeAuth  context.CancelFunc
	stopped     bool
}

func (s *remoteServer) stop() {
	s.configMu.Lock()
	s.stopped = true
	s.revokeAuth()
	s.configMu.Unlock()
	s.server.Stop()
	_ = s.listener.Close()
}
func loadRemoteCertificate(r RemoteConfig) (*tls.Certificate, error) {
	if r.CertFile == "" {
		return nil, nil
	}
	cert, err := tls.LoadX509KeyPair(r.CertFile, r.KeyFile)
	return &cert, err
}

// prepareServer owns a bound socket but does not expose it until state commits.
func (c *Core) prepareServer(r RemoteConfig) (*remoteServer, error) {
	if err := validateRemote(r); err != nil {
		return nil, err
	}
	cert, err := loadRemoteCertificate(r)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", r.Listen)
	if err != nil {
		return nil, fault("unavailable", "remote listener could not be started")
	}
	authContext, revokeAuth := context.WithCancel(c.ctx)
	s := &remoteServer{core: c, listener: listener, config: r, certificate: cert, authContext: authContext, revokeAuth: revokeAuth}
	options := []grpc.ServerOption{grpc.MaxRecvMsgSize(2 * maxPayload), grpc.MaxSendMsgSize(2 * maxPayload), grpc.MaxConcurrentStreams(128), grpc.ConnectionTimeout(remoteHandshakeTimeout), grpc.KeepaliveParams(keepalive.ServerParameters{MaxConnectionIdle: remoteConnectionIdle}), grpc.InTapHandle(s.headerAuth), grpc.UnaryInterceptor(s.unaryAuth), grpc.StreamInterceptor(s.streamAuth)}
	if cert != nil {
		options = append(options, grpc.Creds(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			s.configMu.RLock()
			defer s.configMu.RUnlock()
			return s.certificate, nil
		}})))
	}
	s.server = grpc.NewServer(options...)
	pb.RegisterNotificationCoreServer(s.server, s)
	return s, nil
}
func (s *remoteServer) serve() {
	go func() {
		if err := s.server.Serve(s.listener); err != nil && s.core.ctx.Err() == nil {
			s.core.log("remote_listener_stopped", "", "")
		}
	}()
}
func (c *Core) startServer(r RemoteConfig) error {
	s, err := c.prepareServer(r)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.server = s
	c.mu.Unlock()
	s.serve()
	return nil
}

// reconfigureRemote runs under c.ops. A rejected bind, TLS setup, or persistence
// operation leaves the old socket, subscriptions, and durable state untouched.
func (c *Core) reconfigureRemote(r RemoteConfig, update func(*State) error) error {
	c.mu.Lock()
	old := c.server
	c.mu.Unlock()
	var next *remoteServer
	var cert *tls.Certificate
	var err error
	if r.Enabled {
		reuse := false
		if old != nil {
			old.configMu.RLock()
			reuse = !old.stopped && old.config.Listen == r.Listen
			oldTLS := old.certificate != nil
			old.configMu.RUnlock()
			if reuse && oldTLS != (r.CertFile != "") {
				return fault("conflict", "disable the listener before changing TLS mode on the same address")
			}
		}
		if reuse {
			cert, err = loadRemoteCertificate(r)
			next = old
		} else {
			next, err = c.prepareServer(r)
		}
		if err != nil {
			return err
		}
	}
	if err = c.store.Update(update); err != nil {
		if next != nil && next != old {
			next.stop()
		}
		return err
	}
	if next != nil && next == old {
		next.configMu.Lock()
		if next.config.Token != r.Token {
			// Preserve token revocation even when the bound socket is retained.
			// Same-token certificate reloads may keep existing authenticated RPCs.
			next.revokeAuth()
			next.authContext, next.revokeAuth = context.WithCancel(c.ctx)
		}
		next.config, next.certificate = r, cert
		next.configMu.Unlock()
	}
	c.mu.Lock()
	c.server = next
	c.mu.Unlock()
	if next != nil && next != old {
		next.serve()
	}
	if old != nil && old != next {
		old.stop()
	}
	return nil
}
func (s *remoteServer) auth(ctx context.Context) error {
	s.configMu.RLock()
	defer s.configMu.RUnlock()
	return remoteAuth(ctx, s.config.Token)
}
func remoteAuth(ctx context.Context, token string) error {
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte("Bearer "+token)) != 1 {
		return status.Error(codes.Unauthenticated, "authentication required")
	}
	node := md.Get("nootify-node-id")
	if len(node) != 1 || node[0] == "" || len(node[0]) > 128 {
		return status.Error(codes.Unauthenticated, "node identity required")
	}
	return nil
}

// Authenticate headers before gRPC waits for a unary request body. Otherwise a
// tokenless client can keep a stream active forever and bypass connection idle.
func (s *remoteServer) headerAuth(ctx context.Context, _ *tap.Info) (context.Context, error) {
	return ctx, s.auth(ctx)
}

// Capture the credential generation together with authentication. A concurrent
// token rotation cancels the captured generation, including RPCs admitted just
// before rotation; it cannot attach an old bearer to the new generation.
func (s *remoteServer) authenticatedContext(ctx context.Context) (context.Context, func(), error) {
	s.configMu.RLock()
	err := remoteAuth(ctx, s.config.Token)
	generation := s.authContext
	s.configMu.RUnlock()
	if err != nil {
		return nil, nil, err
	}
	request, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(generation, cancel)
	return request, func() { stop(); cancel() }, nil
}
func (s *remoteServer) unaryAuth(ctx context.Context, req any, _ *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
	ctx, cleanup, err := s.authenticatedContext(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	return next(ctx, req)
}

type authenticatedServerStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *authenticatedServerStream) Context() context.Context { return s.ctx }
func (s *remoteServer) streamAuth(srv any, stream grpc.ServerStream, _ *grpc.StreamServerInfo, next grpc.StreamHandler) error {
	ctx, cleanup, err := s.authenticatedContext(stream.Context())
	if err != nil {
		return err
	}
	defer cleanup()
	return next(srv, &authenticatedServerStream{ServerStream: stream, ctx: ctx})
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

// ensureNodeIdentity upgrades private state without changing any routing UUID.
// The signing key stays outside config backups, just like the peer replay ledger.
func ensureNodeIdentity(d *State) error {
	if d.NodePrivateKey == "" {
		_, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		d.NodePrivateKey = base64.StdEncoding.EncodeToString(private)
	}
	key, err := base64.StdEncoding.DecodeString(d.NodePrivateKey)
	if err != nil || len(key) != ed25519.PrivateKeySize {
		return fault("invalid_argument", "invalid persisted node signing key")
	}
	expected := ed25519.NewKeyFromSeed(key[:ed25519.SeedSize])
	if subtle.ConstantTimeCompare(key, expected) != 1 {
		return fault("invalid_argument", "invalid persisted node signing key")
	}
	return nil
}
func peerIdentityStatus(p Peer) string {
	if p.PublicKey == "" {
		return "legacy_unbound"
	}
	return "pinned"
}
func (c *Core) RemoteIdentity() map[string]string {
	d := c.store.Snapshot()
	key, _ := base64.StdEncoding.DecodeString(d.NodePrivateKey)
	return map[string]string{"node_id": d.NodeID, "public_key": base64.StdEncoding.EncodeToString(ed25519.PrivateKey(key).Public().(ed25519.PublicKey))}
}

// BindPeer is private-local owner approval for pre-proof peer records. It never
// replaces a pin or drops a queue; obtain the key from the owner's other node.
func (c *Core) BindPeer(raw json.RawMessage) (PeerSummary, error) {
	var in struct {
		NodeID    string `json:"node_id"`
		PublicKey string `json:"public_key"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return PeerSummary{}, fault("invalid_argument", "invalid peer binding")
	}
	key, err := base64.StdEncoding.DecodeString(in.PublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize || in.NodeID == "" || in.NodeID == c.node() {
		return PeerSummary{}, fault("invalid_argument", "node identity and Ed25519 public key are required")
	}
	pin := base64.StdEncoding.EncodeToString(key)
	err = c.store.Update(func(d *State) error {
		p, exists := d.Peers[in.NodeID]
		if !exists {
			return fault("not_found", "legacy peer does not exist")
		}
		if p.PublicKey != "" && p.PublicKey != pin {
			return fault("conflict", "peer public key cannot be replaced")
		}
		p.PublicKey = pin
		d.Peers[in.NodeID] = p
		return nil
	})
	if err != nil {
		return PeerSummary{}, err
	}
	p := c.store.Snapshot().Peers[in.NodeID]
	return PeerSummary{NodeID: p.NodeID, Name: p.Name, ConnectedAt: p.ConnectedAt, Pending: len(p.Pending), LastAck: p.LastAck, PublicKey: p.PublicKey, IdentityStatus: "pinned"}, nil
}
func peerProof(server, node, name string, key, challenge []byte) []byte {
	b, _ := json.Marshal([]string{"nootify-subscription-proof-v1", server, node, name, base64.StdEncoding.EncodeToString(key), base64.StdEncoding.EncodeToString(challenge)})
	return b
}
func receivePeerHello(ctx context.Context, recv func() (*pb.SubscriptionFrame, error)) (*pb.Hello, error) {
	type result struct {
		frame *pb.SubscriptionFrame
		err   error
	}
	ch := make(chan result, 1)
	go func() { frame, err := recv(); ch <- result{frame, err} }()
	select {
	case <-ctx.Done():
		return nil, status.Error(codes.DeadlineExceeded, "subscriber handshake timed out")
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		if r.frame.GetHello() == nil {
			return nil, status.Error(codes.InvalidArgument, "expected subscriber identity proof")
		}
		return r.frame.GetHello(), nil
	}
}
func (s *remoteServer) authenticatePeer(stream grpc.BidiStreamingServer[pb.SubscriptionFrame, pb.SubscriptionFrame]) (*pb.Hello, error) {
	ctx, cancel := context.WithTimeout(stream.Context(), remoteHandshakeTimeout)
	defer cancel()
	hello, err := receivePeerHello(ctx, stream.Recv)
	if err != nil {
		return nil, err
	}
	md, _ := metadata.FromIncomingContext(stream.Context())
	if hello.NodeId != md.Get("nootify-node-id")[0] || hello.NodeId == s.core.node() || len(hello.Name) > 256 || len(hello.PublicKey) != ed25519.PublicKeySize || len(hello.Signature) != 0 || len(hello.Challenge) != 0 {
		return nil, status.Error(codes.Unauthenticated, "subscriber identity proof required")
	}
	pin := base64.StdEncoding.EncodeToString(hello.PublicKey)
	if p, exists := s.core.store.Snapshot().Peers[hello.NodeId]; exists {
		if p.PublicKey == "" {
			return nil, status.Error(codes.FailedPrecondition, "legacy peer requires private-local public-key approval")
		}
		if p.PublicKey != pin {
			return nil, status.Error(codes.PermissionDenied, "subscriber public key does not match peer")
		}
	}
	challenge := make([]byte, 32)
	if _, err = rand.Read(challenge); err != nil {
		return nil, status.Error(codes.Internal, "challenge unavailable")
	}
	serverNode := s.core.node()
	if err = stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: serverNode, Challenge: challenge}}}); err != nil {
		return nil, err
	}
	proof, err := receivePeerHello(ctx, stream.Recv)
	if err != nil {
		return nil, err
	}
	if proof.NodeId != hello.NodeId || proof.Name != hello.Name || !ed25519.Verify(ed25519.PublicKey(hello.PublicKey), peerProof(serverNode, hello.NodeId, hello.Name, hello.PublicKey, challenge), proof.Signature) {
		return nil, status.Error(codes.PermissionDenied, "invalid subscriber identity proof")
	}
	err = s.core.store.Update(func(d *State) error {
		p, exists := d.Peers[hello.NodeId]
		if exists && p.PublicKey == "" {
			return status.Error(codes.FailedPrecondition, "legacy peer requires private-local public-key approval")
		}
		if exists && p.PublicKey != pin {
			return status.Error(codes.PermissionDenied, "subscriber public key does not match peer")
		}
		if !exists {
			p = Peer{NodeID: hello.NodeId, Cursor: d.BroadcastSequence, Pending: []string{}}
		}
		p.PublicKey = pin
		d.Peers[hello.NodeId] = p
		return nil
	})
	if err != nil {
		return nil, err
	}
	return hello, nil
}
func (s *remoteServer) Subscribe(stream grpc.BidiStreamingServer[pb.SubscriptionFrame, pb.SubscriptionFrame]) error {
	hello, err := s.authenticatePeer(stream)
	if err != nil {
		return err
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
			if ctx.Err() != nil {
				errors <- status.FromContextError(ctx.Err()).Err()
				return
			}
			if err = sub.Confirm(confirm.EventId); err != nil {
				errors <- status.Error(codes.ResourceExhausted, "confirmation could not be persisted")
				return
			}
		}
	}()
	select {
	case <-ctx.Done():
		return status.FromContextError(ctx.Err()).Err()
	case err := <-errors:
		return err
	}
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
	timer := time.AfterFunc(remoteHandshakeTimeout, cancel)
	defer timer.Stop()
	stream, err := p.client.Subscribe(p.auth(ctx))
	if err != nil {
		return err
	}
	d := p.core.store.Snapshot()
	private, err := base64.StdEncoding.DecodeString(d.NodePrivateKey)
	if err != nil || len(private) != ed25519.PrivateKeySize {
		return fault("unavailable", "node signing identity is unavailable")
	}
	key := ed25519.PrivateKey(private).Public().(ed25519.PublicKey)
	if err = stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: d.NodeID, Name: p.config.Name, PublicKey: key}}}); err != nil {
		return err
	}
	frame, err := stream.Recv()
	if err != nil {
		return err
	}
	hello := frame.GetHello()
	if hello == nil || hello.NodeId == "" || hello.NodeId == d.NodeID || len(hello.Challenge) != 32 {
		return fault("permission_denied", "remote subscription requires an identity challenge")
	}
	serverNode := hello.NodeId
	signature := ed25519.Sign(ed25519.PrivateKey(private), peerProof(serverNode, d.NodeID, p.config.Name, key, hello.Challenge))
	if err = stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: d.NodeID, Name: p.config.Name, Signature: signature}}}); err != nil {
		return err
	}
	frame, err = stream.Recv()
	if err != nil {
		return err
	}
	if frame.GetHello() == nil || frame.GetHello().NodeId != serverNode || len(frame.GetHello().Challenge) != 0 {
		return fault("permission_denied", "remote subscriber identity was not accepted")
	}
	if !timer.Stop() || ctx.Err() != nil {
		return fault("unavailable", "remote identity handshake timed out")
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
	ip = ip.Unmap()
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
