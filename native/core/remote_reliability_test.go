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
func TestReconnectWaitStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForReconnect(ctx, 10*time.Second); err != context.Canceled {
		t.Fatalf("wait returned %v", err)
	}
}
