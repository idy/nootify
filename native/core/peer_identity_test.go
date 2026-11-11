package core

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// These deterministic signing keys are synthetic test fixtures, never production
// enrollment. Reconnecting test clients retain the same independent credential.
func fixturePeerKey(node string) ed25519.PrivateKey {
	seed := sha256.Sum256([]byte("nootify-test-only-peer-key:" + node))
	return ed25519.NewKeyFromSeed(seed[:])
}
func proofStream(t *testing.T, address, token, node string, public ed25519.PublicKey) (pb.NotificationCore_SubscribeClient, *grpc.ClientConn, context.CancelFunc) {
	t.Helper()
	conn, err := grpc.NewClient("passthrough:///"+address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	must(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token, "nootify-node-id", node)
	stream, err := pb.NewNotificationCoreClient(conn).Subscribe(ctx)
	must(t, err)
	must(t, stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: node, PublicKey: public}}}))
	t.Cleanup(func() { cancel(); _ = conn.Close() })
	return stream, conn, cancel
}
func finishPeerProof(t *testing.T, stream pb.NotificationCore_SubscribeClient, node string, private ed25519.PrivateKey) []byte {
	t.Helper()
	frame, err := stream.Recv()
	must(t, err)
	hello := frame.GetHello()
	if hello == nil || len(hello.Challenge) != 32 {
		t.Fatal("missing fresh server challenge")
	}
	sig := ed25519.Sign(private, peerProof(hello.NodeId, node, "", private.Public().(ed25519.PublicKey), hello.Challenge))
	must(t, stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: node, Signature: sig}}}))
	accepted, err := stream.Recv()
	must(t, err)
	if accepted.GetHello() == nil || accepted.GetHello().NodeId != hello.NodeId || len(accepted.GetHello().Challenge) != 0 {
		t.Fatal("peer proof was not admitted")
	}
	return sig
}
func authenticatedStreamClient(t *testing.T, address, token, node string) (pb.NotificationCore_SubscribeClient, *grpc.ClientConn, context.CancelFunc) {
	t.Helper()
	private := fixturePeerKey(node)
	stream, conn, cancel := proofStream(t, address, token, node, private.Public().(ed25519.PublicKey))
	finishPeerProof(t, stream, node, private)
	return stream, conn, cancel
}

func TestPeerIdentityRejectsOfflineImpersonationAndChallengeReplay(t *testing.T) {
	c := testCore(t, nil)
	address, token := testServer(t, c)
	victimKey := fixturePeerKey("victim")
	victim, _, cancelVictim := proofStream(t, address, token, "victim", victimKey.Public().(ed25519.PublicKey))
	oldSignature := finishPeerProof(t, victim, "victim", victimKey)
	cancelVictim()
	event := eventFor("other-owner", "private-backlog")
	must(t, c.Ingest(context.Background(), event, ""))
	before := c.store.Snapshot().Peers["victim"]
	for _, tc := range []struct {
		name string
		key  ed25519.PublicKey
		code codes.Code
	}{
		{"token-only", nil, codes.Unauthenticated},
		{"different-key", fixturePeerKey("attacker").Public().(ed25519.PublicKey), codes.PermissionDenied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			attacker, _, _ := proofStream(t, address, token, "victim", tc.key)
			if _, err := attacker.Recv(); status.Code(err) != tc.code {
				t.Fatalf("impersonation returned %v; want %v", err, tc.code)
			}
		})
	}
	replay, _, _ := proofStream(t, address, token, "victim", victimKey.Public().(ed25519.PublicKey))
	challenge, err := replay.Recv()
	must(t, err)
	if challenge.GetHello() == nil || len(challenge.GetHello().Challenge) != 32 {
		t.Fatal("missing replay challenge")
	}
	must(t, replay.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: "victim", Signature: oldSignature}}}))
	if _, err := replay.Recv(); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("replayed proof returned %v", err)
	}
	// Sending a confirmation on a rejected connection cannot drain the queue.
	_ = replay.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: event.ID}}})
	if !reflect.DeepEqual(before, c.store.Snapshot().Peers["victim"]) {
		t.Fatal("failed proof changed victim's durable queue or pin")
	}
	legitimate, _, _ := authenticatedStreamClient(t, address, token, "victim")
	frame, err := legitimate.Recv()
	must(t, err)
	got, err := parseEvent(frame.GetEvent())
	must(t, err)
	if got.ID != event.ID || !reflect.DeepEqual(got.Session, event.Session) || got.Message != event.Message {
		t.Fatal("authenticated reconnect changed event identity")
	}
	must(t, legitimate.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: event.ID}}}))
	await(t, func() bool { return len(c.store.Snapshot().Peers["victim"].Pending) == 0 })
}

func TestPeerIdentityPinsAndNodeSigningKeySurviveRestart(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	must(t, err)
	c, err := NewCore(context.Background(), store, nil)
	must(t, err)
	address, token := testServer(t, c)
	_, _, cancel := authenticatedStreamClient(t, address, token, "durable-peer")
	cancel()
	must(t, c.Ingest(context.Background(), eventFor("elsewhere", "survives-restart"), ""))
	before := store.Snapshot()
	identity := c.RemoteIdentity()
	c.Close()
	must(t, store.Close())
	store, err = OpenStore(dir)
	must(t, err)
	c, err = NewCore(context.Background(), store, nil)
	must(t, err)
	t.Cleanup(func() { c.Close(); _ = store.Close() })
	must(t, c.Start())
	if before.NodeID != c.node() || before.NodePrivateKey != store.Snapshot().NodePrivateKey || !reflect.DeepEqual(before.Peers, store.Snapshot().Peers) || !reflect.DeepEqual(identity, c.RemoteIdentity()) {
		t.Fatal("restart changed stable UUID, signing identity, or queue")
	}
	if identity["public_key"] == "" {
		t.Fatal("private-local identity has no public key")
	}
	backup, err := json.Marshal(c.ExportConfig())
	must(t, err)
	var exported map[string]any
	must(t, json.Unmarshal(backup, &exported))
	if _, ok := exported["node_private_key"]; ok {
		t.Fatal("config backup exported node signing key")
	}
	stream, _, _ := authenticatedStreamClient(t, c.server.listener.Addr().String(), token, "durable-peer")
	frame, err := stream.Recv()
	must(t, err)
	if frame.GetEvent().EventId != "survives-restart" {
		t.Fatal("pinned peer could not replay after restart")
	}
	attacker, _, _ := proofStream(t, c.server.listener.Addr().String(), token, "durable-peer", fixturePeerKey("other").Public().(ed25519.PublicKey))
	if _, err := attacker.Recv(); status.Code(err) != codes.PermissionDenied {
		t.Fatal("restart forgot pinned public key")
	}
}

func TestLegacyPeerRequiresPrivateLocalOwnerApproval(t *testing.T) {
	c := testCore(t, nil)
	legacy, err := c.Subscribe(context.Background(), "legacy-peer", "Old peer")
	must(t, err)
	legacy.Close()
	must(t, c.Ingest(context.Background(), eventFor("elsewhere", "legacy-backlog"), ""))
	before := c.store.Snapshot()
	address, token := testServer(t, c)
	key := fixturePeerKey("legacy-peer")
	unapproved, _, _ := proofStream(t, address, token, "legacy-peer", key.Public().(ed25519.PublicKey))
	if _, err := unapproved.Recv(); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("legacy peer was enrolled without owner approval: %v", err)
	}
	if !reflect.DeepEqual(before.Peers, c.store.Snapshot().Peers) {
		t.Fatal("unapproved handshake changed legacy queue")
	}
	raw, err := json.Marshal(map[string]string{"node_id": "legacy-peer", "public_key": base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))})
	must(t, err)
	if _, err := c.Handle(context.Background(), "remote.peer.bind", raw, false); publicError(err).Code != "permission_denied" {
		t.Fatal("owner approval was remotely callable")
	}
	if _, err := c.Handle(context.Background(), "remote.identity", json.RawMessage(`{}`), false); publicError(err).Code != "permission_denied" {
		t.Fatal("private identity management was remotely callable")
	}
	_, err = c.BindPeer(raw)
	must(t, err)
	_, err = c.BindPeer(raw)
	must(t, err)
	approved := c.store.Snapshot()
	if !reflect.DeepEqual(before.Peers["legacy-peer"].Pending, approved.Peers["legacy-peer"].Pending) || before.NodeID != approved.NodeID || !reflect.DeepEqual(before.Bindings, approved.Bindings) || !reflect.DeepEqual(before.Events, approved.Events) {
		t.Fatal("owner approval changed routing identities or queue")
	}
	wrong, err := json.Marshal(map[string]string{"node_id": "legacy-peer", "public_key": base64.StdEncoding.EncodeToString(fixturePeerKey("intruder").Public().(ed25519.PublicKey))})
	must(t, err)
	if _, err = c.BindPeer(wrong); publicError(err).Code != "conflict" {
		t.Fatal("owner approval replaced an existing pin")
	}
	stream, _, _ := authenticatedStreamClient(t, address, token, "legacy-peer")
	frame, err := stream.Recv()
	must(t, err)
	if frame.GetEvent().EventId != "legacy-backlog" {
		t.Fatal("approved legacy peer lost backlog")
	}
}

func TestRemoteRejectsUnauthenticatedUnaryBeforeReadingBody(t *testing.T) {
	c := testCore(t, nil)
	address, _ := testServer(t, c)
	conn, err := grpc.NewClient("passthrough:///"+address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	must(t, err)
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Send only HTTP/2 request headers, with no unary message or EOF. Header
	// authentication must reject this stream without waiting for the body.
	stream, err := conn.NewStream(ctx, &grpc.StreamDesc{}, pb.NotificationCore_Call_FullMethodName)
	must(t, err)
	err = stream.RecvMsg(&pb.Result{})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("silent unauthenticated unary stream returned %v", err)
	}
}

func TestRemoteIdleConnectionExpiresWhileHealthySubscriptionSurvives(t *testing.T) {
	c := testCore(t, nil)
	address, token := testServer(t, c)
	idle, err := grpc.NewClient("passthrough:///"+address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	must(t, err)
	defer idle.Close()
	idle.Connect()
	await(t, func() bool { return idle.GetState() == connectivity.Ready })
	active, _, _ := authenticatedStreamClient(t, address, token, "healthy-idle-subscription")
	ctx, cancel := context.WithTimeout(context.Background(), remoteConnectionIdle+5*time.Second)
	defer cancel()
	for idle.GetState() == connectivity.Ready {
		if !idle.WaitForStateChange(ctx, connectivity.Ready) {
			t.Fatal("unused HTTP/2 connection did not expire")
		}
	}
	// MaxConnectionIdle must count active RPCs: a quiet subscription stays usable.
	must(t, c.Ingest(context.Background(), eventFor("elsewhere", "after-idle-timeout"), ""))
	frame, err := active.Recv()
	must(t, err)
	if frame.GetEvent().EventId != "after-idle-timeout" {
		t.Fatal("healthy subscription was expired with idle transports")
	}
}

func TestRemoteBoundsUnfinishedTransportAndSubscriberHandshakes(t *testing.T) {
	c := testCore(t, nil)
	address, token := testServer(t, c)
	raw, err := net.Dial("tcp", address)
	must(t, err)
	defer raw.Close()
	must(t, raw.SetReadDeadline(time.Now().Add(remoteHandshakeTimeout+3*time.Second)))
	key := fixturePeerKey("unfinished")
	unfinished, _, _ := proofStream(t, address, token, "unfinished", key.Public().(ed25519.PublicKey))
	_, err = unfinished.Recv() // Server sends challenge, client never proves possession.
	must(t, err)
	started := time.Now()
	if _, err = unfinished.Recv(); status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("unfinished proof was not bounded: %v", err)
	}
	if time.Since(started) > remoteHandshakeTimeout+2*time.Second {
		t.Fatal("proof exceeded handshake budget")
	}
	var b [1024]byte
	for {
		_, err = raw.Read(b[:])
		if err != nil {
			break
		}
	}
	if e, ok := err.(net.Error); ok && e.Timeout() {
		t.Fatal("transport preface never timed out")
	}
	if _, exists := c.store.Snapshot().Peers["unfinished"]; exists {
		t.Fatal("unfinished proof enrolled a peer")
	}
}
