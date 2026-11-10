package main

import (
	"context"
	"net"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/status"
)

type recoveringRemote struct {
	pb.UnimplementedNotificationCoreServer
	attempts   atomic.Int32
	failures   int32
	callBudget chan time.Duration
}

func (s *recoveringRemote) Subscribe(stream grpc.BidiStreamingServer[pb.SubscriptionFrame, pb.SubscriptionFrame]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	if s.attempts.Add(1) <= s.failures {
		return status.Error(codes.Unavailable, "temporarily unavailable")
	}
	if err := stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: "upstream", Challenge: make([]byte, 32)}}}); err != nil {
		return err
	}
	if _, err := stream.Recv(); err != nil {
		return err
	}
	if err := stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: "upstream"}}}); err != nil {
		return err
	}
	return status.Error(codes.Unavailable, "connection dropped after handshake")
}
func (s *recoveringRemote) Call(ctx context.Context, _ *pb.Command) (*pb.Result, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "missing request deadline")
	}
	s.callBudget <- time.Until(deadline)
	return &pb.Result{ResultJson: []byte(`{}`)}, nil
}
func recoveryProvider(t *testing.T, server *recoveringRemote) *remoteProvider {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	grpcServer := grpc.NewServer()
	pb.RegisterNotificationCoreServer(grpcServer, server)
	go func() { _ = grpcServer.Serve(listener) }()
	t.Cleanup(grpcServer.Stop)
	c := testCore(t, nil)
	p := newRemoteProvider(c, ProviderConfig{ID: "remote", Type: "remote", Name: "Remote", Address: listener.Addr().String(), Token: "synthetic-test-token"})
	t.Cleanup(func() { _ = p.Close() })
	return p
}
func TestRemoteReconnectResetsAfterHandshakeAndCapsFailures(t *testing.T) {
	server := &recoveringRemote{failures: 9}
	p := recoveryProvider(t, server)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var delays []time.Duration
	p.retryWait = func(ctx context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		if len(delays) == 11 {
			cancel()
			return ctx.Err()
		}
		return nil
	}
	_ = p.Subscribe(ctx, func(context.Context, Event) error { return nil })
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond,
		800 * time.Millisecond, 1600 * time.Millisecond, 3200 * time.Millisecond, 6400 * time.Millisecond,
		10 * time.Second, 10 * time.Second, 100 * time.Millisecond, 100 * time.Millisecond}
	if !reflect.DeepEqual(delays, want) {
		t.Fatalf("reconnect delays = %v; want %v", delays, want)
	}
}
func TestRemoteCallPreservesParentDeadline(t *testing.T) {
	server := &recoveringRemote{callBudget: make(chan time.Duration, 2)}
	p := recoveryProvider(t, server)
	must(t, p.call(context.Background(), "message.send", map[string]any{}, nil))
	if remaining := <-server.callBudget; remaining < 40*time.Second || remaining > 45*time.Second {
		t.Fatalf("default remote deadline budget %v", remaining)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	must(t, p.call(ctx, "message.send", map[string]any{}, nil))
	if remaining := <-server.callBudget; remaining <= 0 || remaining > 3*time.Second {
		t.Fatalf("remote extended the parent deadline: %v", remaining)
	}
}
func TestReturnProviderPrefersConnectedRouteAndPreservesFallback(t *testing.T) {
	for _, firstStatus := range []string{"", "connecting", "reconnecting", "failed", "connected"} {
		t.Run(firstStatus, func(t *testing.T) {
			c := testCore(t, nil)
			first := installFake(t, c, "first")
			second := installFake(t, c, "second")
			ref := MessageRef{OriginNodeID: "origin", ProviderID: "bot", MessageID: "incoming"}
			must(t, c.store.Update(func(d *State) error {
				remember(d, ref, "missing")
				remember(d, ref, "first")
				remember(d, ref, "second")
				return nil
			}))
			c.setStatus("first", firstStatus)
			c.setStatus("second", "connected")
			want := second
			if firstStatus == "connected" {
				want = first
			}
			got, err := c.returnProvider(ref)
			must(t, err)
			if got != want {
				t.Fatal("connected routes did not take priority in retained order")
			}
			c.setStatus("first", "reconnecting")
			c.setStatus("second", "connecting")
			got, err = c.returnProvider(ref)
			must(t, err)
			if got != first {
				t.Fatal("no connected route lost the original first-available fallback")
			}
		})
	}
}

func awaitProviderStatus(t *testing.T, c *Core, id, want string) {
	t.Helper()
	await(t, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.statuses[id] == want
	})
}

type returnRouteFixture struct {
	origin, first, second, downstream *Core
	bot                               *fakeProvider
	firstRemote, secondRemote         *remoteProvider
	ref                               MessageRef
}

func newReturnRouteFixture(t *testing.T) returnRouteFixture {
	t.Helper()
	f := returnRouteFixture{origin: testCore(t, nil), first: testCore(t, nil), second: testCore(t, nil), downstream: testCore(t, nil)}
	f.bot = installFake(t, f.origin, "bot")
	originAddress, originToken := testServer(t, f.origin)
	addRemote(t, f.first, "origin", originAddress, originToken)
	addRemote(t, f.second, "origin", originAddress, originToken)
	firstAddress, firstToken := testServer(t, f.first)
	secondAddress, secondToken := testServer(t, f.second)
	f.firstRemote = addRemote(t, f.downstream, "first", firstAddress, firstToken)
	f.secondRemote = addRemote(t, f.downstream, "second", secondAddress, secondToken)
	awaitProviderStatus(t, f.first, "origin", "connected")
	awaitProviderStatus(t, f.second, "origin", "connected")
	awaitProviderStatus(t, f.downstream, "first", "connected")
	awaitProviderStatus(t, f.downstream, "second", "connected")
	f.ref = MessageRef{OriginNodeID: f.origin.node(), ProviderID: "bot", MessageID: "incoming"}
	event := Event{ID: "two-upstreams", Message: f.ref, Session: Session{NodeID: f.downstream.node(), Adapter: "codex", SessionID: "return-route"}, Content: Content{Text: "incoming"}, Hops: 16}
	// Deliver the same event over both actual gRPC subscriptions in a fixed
	// order. The duplicate must retain the second route without redelivery.
	must(t, f.first.Ingest(context.Background(), event, "origin"))
	await(t, func() bool { return len(f.downstream.store.Snapshot().References[f.ref.key()].Routes) == 1 })
	must(t, f.second.Ingest(context.Background(), event, "origin"))
	await(t, func() bool { return len(f.downstream.store.Snapshot().References[f.ref.key()].Routes) == 2 })
	routes := f.downstream.store.Snapshot().References[f.ref.key()].Routes
	if routes[0] != "first" || routes[1] != "second" {
		t.Fatalf("unexpected return route order: %v", routes)
	}
	return f
}

func TestRemoteReturnRouteUsesConnectedUpstreamAfterFirstDisconnects(t *testing.T) {
	f := newReturnRouteFixture(t)
	f.first.server.stop()
	awaitProviderStatus(t, f.downstream, "first", "reconnecting")
	await(t, func() bool { return f.firstRemote.conn.GetState() != connectivity.Ready })
	if f.secondRemote.conn.GetState() != connectivity.Ready {
		t.Fatal("second upstream is not connected")
	}
	f.downstream.mu.Lock()
	retained := f.downstream.providers["first"] == f.firstRemote
	f.downstream.mu.Unlock()
	if !retained {
		t.Fatal("fixture removed the disconnected provider instead of retaining it")
	}
	selected, err := f.downstream.returnProvider(f.ref)
	must(t, err)
	if selected != f.secondRemote {
		t.Fatal("selected disconnected first upstream instead of connected second upstream")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	first, err := f.downstream.Reply(ctx, f.ref, Content{Text: "reply"}, "stable")
	must(t, err)
	again, err := f.downstream.Reply(ctx, f.ref, Content{Text: "reply"}, "stable")
	must(t, err)
	ack, err := f.downstream.Ack(ctx, f.ref)
	must(t, err)
	ackAgain, err := f.downstream.Ack(ctx, f.ref)
	must(t, err)
	f.bot.mu.Lock()
	replies, acks, lastReply, lastAck := f.bot.replies, f.bot.acks, f.bot.lastReply, f.bot.lastAck
	f.bot.mu.Unlock()
	if first.Message != again.Message || replies != 1 || acks != 1 || lastReply != f.ref || lastAck != f.ref {
		t.Fatalf("reply/ack were lost or duplicated: replies=%d acks=%d", replies, acks)
	}
	if ack["acknowledged_at"] == "" || ack["acknowledged_at"] != ackAgain["acknowledged_at"] {
		t.Fatal("successful acknowledgment timestamp was not retained")
	}
	if len(f.first.store.Snapshot().Operations) != 0 || len(f.second.store.Snapshot().Operations) != 1 || f.second.store.Snapshot().References[f.ref.key()].AcknowledgedAt == "" {
		t.Fatal("reply or acknowledgment did not use only the second upstream")
	}
}

func TestRemoteReturnRouteNeverRetriesUncertainReplyOnAnotherUpstream(t *testing.T) {
	f := newReturnRouteFixture(t)
	accepted, release := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		close(release)
		select {
		case <-accepted:
			// Drain the admitted calls before temporary stores are removed.
			key := "reply:" + f.ref.key() + ":stable"
			await(t, func() bool { return f.origin.store.Snapshot().Operations[key].State == "complete" })
			await(t, func() bool { return f.first.store.Snapshot().Operations[key].State == "unconfirmed" })
		default:
		}
	})
	installRoutingBot(f.origin, "bot", &routingTestBot{Bot: f.bot, reply: func(ctx context.Context, ref MessageRef, content Content, request string) (SendResult, error) {
		result, err := f.bot.Reply(ctx, ref, content, request)
		close(accepted)
		<-release
		return result, err
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	outcome := make(chan error, 1)
	go func() {
		_, err := f.downstream.Reply(ctx, f.ref, Content{Text: "uncertain"}, "stable")
		outcome <- err
	}()
	waitRouting(t, accepted)
	// The origin accepted once, but the selected relay loses its connection
	// before returning a result. A healthy alternate cannot prove non-acceptance.
	f.first.server.stop()
	select {
	case err := <-outcome:
		if publicError(err).Code != "unconfirmed" {
			t.Fatalf("lost response returned %v; want unconfirmed", err)
		}
	case <-ctx.Done():
		t.Fatal("disconnected reply did not finish")
	}
	awaitProviderStatus(t, f.downstream, "first", "reconnecting")
	selected, err := f.downstream.returnProvider(f.ref)
	must(t, err)
	if selected != f.secondRemote {
		t.Fatal("alternate upstream was not available after response loss")
	}
	_, err = f.downstream.Reply(ctx, f.ref, Content{Text: "uncertain"}, "stable")
	if publicError(err).Code != "unconfirmed" {
		t.Fatalf("uncertain request retry returned %v; want unconfirmed", err)
	}
	f.bot.mu.Lock()
	replies, acks := f.bot.replies, f.bot.acks
	f.bot.mu.Unlock()
	operation := f.downstream.store.Snapshot().Operations["reply:"+f.ref.key()+":stable"]
	if replies != 1 || acks != 0 || operation.State != "unconfirmed" || len(f.second.store.Snapshot().Operations) != 0 || f.downstream.store.Snapshot().References[f.ref.key()].AcknowledgedAt != "" {
		t.Fatal("uncertain reply was retried or acknowledged without an explicit acknowledgment")
	}
}

type returnRouteAckBot struct {
	Bot
	accepted chan struct{}
	release  <-chan struct{}
}

func (b *returnRouteAckBot) Ack(ctx context.Context, ref MessageRef) error {
	err := b.Bot.Ack(ctx, ref)
	close(b.accepted)
	<-b.release
	return err
}

func TestRemoteReturnRouteAckPersistsOnlyAfterSuccessAndDoesNotFailOver(t *testing.T) {
	f := newReturnRouteFixture(t)
	accepted, release := make(chan struct{}), make(chan struct{})
	// Always release the origin before Core/Store cleanup, including on failure.
	released := false
	t.Cleanup(func() {
		if !released {
			close(release)
		}
		select {
		case <-accepted:
			await(t, func() bool { return f.origin.store.Snapshot().References[f.ref.key()].AcknowledgedAt != "" })
		default:
		}
	})
	installRoutingBot(f.origin, "bot", &returnRouteAckBot{Bot: f.bot, accepted: accepted, release: release})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	outcome := make(chan error, 1)
	go func() { _, err := f.downstream.Ack(ctx, f.ref); outcome <- err }()
	waitRouting(t, accepted)
	f.first.server.stop()
	select {
	case err := <-outcome:
		if err == nil {
			t.Fatal("lost acknowledgment response unexpectedly succeeded")
		}
	case <-ctx.Done():
		t.Fatal("disconnected acknowledgment did not finish")
	}
	if f.downstream.store.Snapshot().References[f.ref.key()].AcknowledgedAt != "" || f.second.store.Snapshot().References[f.ref.key()].AcknowledgedAt != "" {
		t.Fatal("failed acknowledgment was persisted or automatically tried on another upstream")
	}
	close(release)
	released = true
	await(t, func() bool { return f.origin.store.Snapshot().References[f.ref.key()].AcknowledgedAt != "" })
	awaitProviderStatus(t, f.downstream, "first", "reconnecting")
	_, err := f.downstream.Ack(ctx, f.ref)
	must(t, err)
	_, err = f.downstream.Ack(ctx, f.ref)
	must(t, err)
	f.bot.mu.Lock()
	acks := f.bot.acks
	f.bot.mu.Unlock()
	if acks != 1 || f.downstream.store.Snapshot().References[f.ref.key()].AcknowledgedAt == "" || f.second.store.Snapshot().References[f.ref.key()].AcknowledgedAt == "" {
		t.Fatal("explicit acknowledgment retry did not use the alternate route and retain success")
	}
}

func TestReconnectWaitStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForReconnect(ctx, 10*time.Second); err != context.Canceled {
		t.Fatalf("wait returned %v", err)
	}
}
