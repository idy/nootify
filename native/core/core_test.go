package core

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func testCore(t *testing.T, emit func(string, any) error) *Core {
	t.Helper()
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewCore(context.Background(), s, emit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(); s.Close() })
	return c
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func await(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		if predicate() {
			return
		}
		select {
		case <-deadline:
			t.Fatal("condition did not become true")
		case <-tick.C:
		}
	}
}
func eventFor(node, id string) Event {
	return Event{ID: id, Session: Session{NodeID: node, Adapter: "codex", SessionID: "session"}, Message: MessageRef{OriginNodeID: "source", ProviderID: "bot", MessageID: id}, Content: Content{Text: "reply"}, Hops: 16}
}
func testServer(t *testing.T, c *Core) (string, string) {
	t.Helper()
	r := RemoteConfig{Enabled: true, Listen: "127.0.0.1:0", Token: strings.Repeat("x", 32)}
	must(t, c.store.Update(func(d *State) error { d.Remote = r; return nil }))
	must(t, c.startServer(r))
	return c.server.listener.Addr().String(), r.Token
}
func streamClient(t *testing.T, address, token, node string) (pb.NotificationCore_SubscribeClient, *grpc.ClientConn, context.CancelFunc) {
	return authenticatedStreamClient(t, address, token, node)
}
func TestGRPCBroadcastIndependentConfirmationAndReconnect(t *testing.T) {
	c := testCore(t, nil)
	address, token := testServer(t, c)
	one, _, cancelOne := streamClient(t, address, token, "peer-one")
	two, _, cancelTwo := streamClient(t, address, token, "peer-two")
	must(t, c.Ingest(context.Background(), eventFor("owner-elsewhere", "shared"), ""))
	a, err := one.Recv()
	must(t, err)
	b, err := two.Recv()
	must(t, err)
	if a.GetEvent().EventId != "shared" || b.GetEvent().EventId != "shared" {
		t.Fatal("not broadcast to both peers")
	}
	must(t, one.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: "shared"}}}))
	await(t, func() bool { return len(c.store.Snapshot().Peers["peer-one"].Pending) == 0 })
	if len(c.store.Snapshot().Peers["peer-two"].Pending) != 1 {
		t.Fatal("one peer consumed another's event")
	}
	cancelOne()
	cancelTwo()
	twoAgain, _, _ := streamClient(t, address, token, "peer-two")
	replayed, err := twoAgain.Recv()
	must(t, err)
	if replayed.GetEvent().EventId != "shared" {
		t.Fatal("reconnect did not replay stable event ID")
	}
	must(t, twoAgain.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: "shared"}}}))
	await(t, func() bool { return len(c.store.Snapshot().Peers["peer-two"].Pending) == 0 })
}
func TestLocalOwnershipNeverBroadcastsAndDeduplicatesRoutes(t *testing.T) {
	var mu sync.Mutex
	count := 0
	c := testCore(t, func(name string, data any) error {
		if name == "delivery" {
			mu.Lock()
			count++
			mu.Unlock()
		}
		return nil
	})
	sub, err := c.Subscribe(context.Background(), "downstream", "")
	must(t, err)
	defer sub.Close()
	e := eventFor(c.node(), "owned")
	must(t, c.Ingest(context.Background(), e, "first"))
	must(t, c.Ingest(context.Background(), e, "second"))
	mu.Lock()
	n := count
	mu.Unlock()
	if n != 1 {
		t.Fatalf("local executed %d times", n)
	}
	d := c.store.Snapshot()
	if len(d.Peers["downstream"].Pending) != 0 {
		t.Fatal("locally owned session was broadcast")
	}
	if len(d.References[e.Message.key()].Routes) != 2 {
		t.Fatal("multiple return paths were not retained")
	}
	for id := range d.Deliveries {
		must(t, c.Complete(id, "retryable", "offline", ""))
	}
	if len(c.store.Snapshot().Peers["downstream"].Pending) != 0 {
		t.Fatal("failed local owner was rerouted")
	}
}
func TestLoopSuppressionWithFullPeerWindow(t *testing.T) {
	c := testCore(t, nil)
	s, err := c.Subscribe(context.Background(), "downstream", "")
	must(t, err)
	defer s.Close()
	loop := eventFor("elsewhere", "loop")
	loop.Visited = []string{c.node()}
	must(t, c.Ingest(context.Background(), loop, ""))
	if len(c.store.Snapshot().Peers["downstream"].Pending) != 0 {
		t.Fatal("loop was broadcast")
	}
	must(t, c.store.Update(func(d *State) error {
		p := d.Peers["downstream"]
		p.Pending = make([]string, maxPending)
		d.Peers[p.NodeID] = p
		return nil
	}))
	must(t, c.Ingest(context.Background(), eventFor("elsewhere", "full"), ""))
	if _, ok := c.store.Snapshot().Events["full"]; !ok {
		t.Fatal("full delivery window rejected durable broadcast")
	}
	if len(c.store.Snapshot().Peers["downstream"].Pending) != maxPending {
		t.Fatal("peer delivery window exceeded its bound")
	}
}

type fakeProvider struct {
	mu                                     sync.Mutex
	node, id                               string
	ensures, deletes, sends, replies, acks int
	lastAck                                MessageRef
	lastReply                              MessageRef
	failSend                               bool
	deleteErr                              error
	sendErr                                error
	replyErr                               error
	requests                               []string
	ensure                                 func(context.Context, Session) (Binding, error)
}

func (p *fakeProvider) Ensure(ctx context.Context, s Session) (Binding, error) {
	if p.ensure != nil {
		return p.ensure(ctx, s)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensures++
	return Binding{ProviderID: p.id, Session: s, ChatID: fmt.Sprintf("group-%s-%s-%d", p.id, s.SessionID, p.ensures)}, nil
}
func (p *fakeProvider) Metadata(_ context.Context, b Binding, m map[string]any, set bool) (map[string]any, error) {
	if set {
		return m, nil
	}
	return b.Session.Metadata, nil
}
func (p *fakeProvider) Delete(context.Context, Binding) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deletes++
	return p.deleteErr
}
func (p *fakeProvider) Send(_ context.Context, b Binding, c Content, r string) (SendResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sends++
	p.requests = append(p.requests, r)
	if p.sendErr != nil {
		return SendResult{}, p.sendErr
	}
	if p.failSend {
		return SendResult{}, fault("unavailable", "send uncertain")
	}
	m := MessageRef{OriginNodeID: p.node, ProviderID: p.id, MessageID: fmt.Sprintf("sent-%d", p.sends)}
	return SendResult{Message: m, MessageID: m.MessageID, ChatID: b.ChatID}, nil
}
func (p *fakeProvider) Reply(_ context.Context, m MessageRef, c Content, r string) (SendResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.replies++
	p.requests = append(p.requests, r)
	if p.replyErr != nil {
		return SendResult{}, p.replyErr
	}
	p.lastReply = m
	ref := MessageRef{OriginNodeID: p.node, ProviderID: p.id, MessageID: fmt.Sprintf("reply-%d", p.replies)}
	return SendResult{Message: ref, MessageID: ref.MessageID}, nil
}
func (p *fakeProvider) Ack(_ context.Context, m MessageRef) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.acks++
	p.lastAck = m
	return nil
}
func (p *fakeProvider) Close() error { return nil }
func (p *fakeProvider) GetMetadata(ctx context.Context, b Binding) (map[string]any, error) {
	return p.Metadata(ctx, b, nil, false)
}
func (p *fakeProvider) SetMetadata(ctx context.Context, b Binding, m map[string]any) (map[string]any, error) {
	return p.Metadata(ctx, b, m, true)
}
func (p *fakeProvider) Subscribe(ctx context.Context, receive EventHandler) error {
	<-ctx.Done()
	return ctx.Err()
}
func installFake(t *testing.T, c *Core, id string) *fakeProvider {
	t.Helper()
	p := &fakeProvider{node: c.node(), id: id}
	c.mu.Lock()
	c.providers[id] = p
	c.mu.Unlock()
	must(t, c.store.Update(func(d *State) error {
		d.Providers[id] = ProviderConfig{ID: id, Name: id, Type: "feishu", AppID: "app", AppSecret: "private", Enabled: false}
		d.DefaultProvider = id
		return nil
	}))
	return p
}
func TestSessionsProviderScopeMetadataTombstonesAndIdempotency(t *testing.T) {
	c := testCore(t, nil)
	p := installFake(t, c, "bot-one")
	installFake(t, c, "bot-two")
	s := Session{Adapter: "codex", SessionID: "same"}
	b, err := c.Ensure(context.Background(), "bot-one", s)
	must(t, err)
	if !b.Created {
		t.Fatal("new session not created")
	}
	_, err = c.Ensure(context.Background(), "bot-two", s)
	if publicError(err).Code != "conflict" {
		t.Fatal("binding silently moved providers")
	}
	other := s
	other.Adapter = "claude"
	_, err = c.Ensure(context.Background(), "bot-two", other)
	must(t, err)
	metadata := map[string]any{"custom": "preserved"}
	_, err = c.SetMetadata(context.Background(), "bot-one", s, metadata)
	must(t, err)
	got, err := c.GetMetadata(context.Background(), "", s)
	must(t, err)
	if got["custom"] != "preserved" {
		t.Fatal("metadata lost")
	}
	one, err := c.Send(context.Background(), "", s, Content{Text: "progress"}, "request")
	must(t, err)
	two, err := c.Send(context.Background(), "", s, Content{Text: "progress"}, "request")
	must(t, err)
	if one.Message != two.Message || p.sends != 1 {
		t.Fatal("request retry sent twice")
	}
	_, err = c.Send(context.Background(), "", s, Content{Text: "changed"}, "request")
	if publicError(err).Code != "conflict" {
		t.Fatal("request reused for different payload")
	}
	must(t, c.Delete(context.Background(), "", s))
	must(t, c.Delete(context.Background(), "", s))
	if p.deletes != 1 {
		t.Fatal("delete is not idempotent")
	}
	e := eventFor(c.node(), "deleted")
	e.Session = b.Session
	must(t, c.Ingest(context.Background(), e, ""))
	if c.store.Snapshot().Events[e.ID].Outcome != "deleted" {
		t.Fatal("tombstone did not suppress replay")
	}
	_, err = c.Ensure(context.Background(), "bot-one", s)
	must(t, err)
	if c.store.Snapshot().Bindings[b.Session.key()].Deleted {
		t.Fatal("explicit ensure did not reactivate")
	}
}
func TestUncertainSendDoesNotRetry(t *testing.T) {
	c := testCore(t, nil)
	p := installFake(t, c, "bot")
	p.failSend = true
	s := Session{Adapter: "codex", SessionID: "s"}
	_, err := c.Ensure(context.Background(), "", s)
	must(t, err)
	_, err = c.Send(context.Background(), "", s, Content{Text: "hello"}, "request")
	if err == nil {
		t.Fatal("expected failure")
	}
	_, err = c.Send(context.Background(), "", s, Content{Text: "hello"}, "request")
	if publicError(err).Code != "unconfirmed" || p.sends != 1 {
		t.Fatal("uncertain operation was repeated")
	}
}
func TestMessageIDAmbiguity(t *testing.T) {
	c := testCore(t, nil)
	a := MessageRef{OriginNodeID: "upstream", ProviderID: "bot-one", MessageID: "same-id"}
	b := MessageRef{OriginNodeID: "upstream", ProviderID: "bot-two", MessageID: "same-id"}
	must(t, c.store.Update(func(d *State) error { remember(d, a, "remote-a"); return nil }))
	got, err := c.Resolve(nil, "same-id")
	must(t, err)
	if got != a {
		t.Fatal("full ref not retained")
	}
	must(t, c.store.Update(func(d *State) error { remember(d, b, "remote-b"); return nil }))
	_, err = c.Resolve(nil, "same-id")
	if publicError(err).Code != "ambiguous_message" {
		t.Fatal("ambiguous bare ID accepted")
	}
	got, err = c.Resolve(&a, "")
	must(t, err)
	if got != a {
		t.Fatal("full ref changed")
	}
}
func TestPersistenceRecoveryAndPermissions(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	must(t, err)
	c, err := NewCore(context.Background(), s, func(string, any) error { return nil })
	must(t, err)
	node := c.node()
	e := eventFor(node, "pending-at-crash")
	must(t, c.Ingest(context.Background(), e, ""))
	sub, err := c.Subscribe(context.Background(), "offline", "")
	must(t, err)
	sub.Close()
	must(t, c.Ingest(context.Background(), eventFor("other", "offline-event"), ""))
	must(t, c.Delete(context.Background(), "", Session{NodeID: node, Adapter: "codex", SessionID: "deleted"}))
	if other, err := OpenStore(dir); err == nil {
		other.Close()
		t.Fatal("second writer was allowed")
	}
	c.Close()
	must(t, s.Close())
	s, err = OpenStore(dir)
	must(t, err)
	defer s.Close()
	c, err = NewCore(context.Background(), s, nil)
	must(t, err)
	defer c.Close()
	if c.node() != node {
		t.Fatal("node identity changed")
	}
	for _, d := range s.Snapshot().Deliveries {
		if d.Status != "unconfirmed" {
			t.Fatal("uncertain local submission would be retried")
		}
	}
	if len(s.Snapshot().Peers["offline"].Pending) != 1 {
		t.Fatal("offline queue lost")
	}
	if !s.Snapshot().Bindings[(Session{NodeID: node, Adapter: "codex", SessionID: "deleted"}).key()].Deleted {
		t.Fatal("tombstone lost")
	}
	for _, path := range []string{dir, filepath.Join(dir, "state.json")} {
		info, err := os.Stat(path)
		must(t, err)
		if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
			t.Fatal("state is not private")
		}
	}
}
func TestRichTextMapping(t *testing.T) {
	c := Content{Blocks: []ContentBlock{{Type: "paragraph", Children: []ContentBlock{{Type: "text", Text: "See "}, {Type: "link", Text: "guide", URL: "https://example.com"}}}, {Type: "code", Text: "fmt.Println(1)"}}}
	kind, body, err := toFeishu(c)
	must(t, err)
	if kind != "post" || !strings.Contains(body, "code_block") || !strings.Contains(body, "href") {
		t.Fatal("rich nodes were flattened")
	}
	round, err := fromFeishu(kind, body)
	must(t, err)
	if !strings.Contains(round.Plain(), "See guide") || !strings.Contains(round.Plain(), "fmt.Println(1)") {
		t.Fatal("post content lost")
	}
	_, err = fromFeishu("post", `{"content":[[{"tag":"img","image_key":"secret"}]]}`)
	if err == nil {
		t.Fatal("unsupported input element silently dropped")
	}
	_, _, err = toFeishu(Content{Blocks: []ContentBlock{{Type: "image", Text: "x"}}})
	if err == nil {
		t.Fatal("unsupported outgoing block accepted")
	}
}
func TestContentRejectsBoundedDeepPayloadBeforeCopyingText(t *testing.T) {
	block := ContentBlock{Type: "text", Text: strings.Repeat("bounded ", 1024)}
	for i := 0; i < 256; i++ {
		block = ContentBlock{Type: "text", Children: []ContentBlock{block}}
	}
	content := Content{Blocks: []ContentBlock{block}}
	encoded, err := json.Marshal(content)
	must(t, err)
	if len(encoded) >= maxPayload {
		t.Fatal("fixture must fit within the payload limit")
	}
	var rejection error
	// A small fixture and two validation calls are enough to detect recursive
	// text copies. Avoid a load test or machine-dependent timing threshold.
	allocations := testing.AllocsPerRun(1, func() { rejection = content.Validate() })
	if rejection == nil || publicError(rejection).Code != "invalid_argument" || rejection.Error() != "content nesting exceeds limit" {
		t.Fatalf("deep content returned %v; want the nesting rejection", rejection)
	}
	if allocations > 8 {
		t.Fatalf("deep validation allocated %.0f objects; tree should reject before encoding or flattening", allocations)
	}
}

func TestContentPlainAndValidationPreserveRichSemantics(t *testing.T) {
	rich := Content{Text: "intro ", Blocks: []ContentBlock{
		{Type: "paragraph", Text: "first ", Children: []ContentBlock{
			{Type: "text", Text: "styled "},
			{Type: "link", Text: "link", URL: "https://example.com", Children: []ContentBlock{{Type: "text", Text: " label"}}},
		}},
		{Type: "code", Text: "x\n", Children: []ContentBlock{{Type: "text", Text: "y"}}},
		{Type: "paragraph", Children: []ContentBlock{{Type: "paragraph", Text: "nested"}, {Type: "text", Text: "tail"}}},
	}}
	must(t, rich.Validate())
	if got, want := rich.Plain(), "intro first styled link label\nx\ny\nnested\ntail"; got != want {
		t.Fatalf("rich plain text = %q, want %q", got, want)
	}
	if got := (Content{Text: "text\n\n"}).Plain(); got != "text\n" {
		t.Fatalf("plain text trimmed more than one trailing newline: %q", got)
	}
	leaf := ContentBlock{Type: "text", Text: "leaf"}
	for i := 1; i < 16; i++ {
		leaf = ContentBlock{Type: "text", Children: []ContentBlock{leaf}}
	}
	atLimit := Content{Blocks: []ContentBlock{leaf}}
	must(t, atLimit.Validate())
	if atLimit.Plain() != "leaf" {
		t.Fatal("valid nested text changed")
	}
	for _, tc := range []struct {
		name    string
		content Content
		code    string
	}{
		{"empty", Content{}, "invalid_argument"},
		{"unicode whitespace", Content{Text: " \t\n ", Blocks: []ContentBlock{{Type: "paragraph"}}}, "invalid_argument"},
		{"unsupported shape", Content{Blocks: []ContentBlock{{Type: "image", Text: "x"}}}, "unsupported_content"},
		{"invalid link", Content{Blocks: []ContentBlock{{Type: "link", Text: "x", URL: "file:///private"}}}, "invalid_argument"},
		{"empty link label", Content{Blocks: []ContentBlock{{Type: "link", URL: "https://example.com"}}}, "invalid_argument"},
		{"above depth limit", Content{Blocks: []ContentBlock{{Type: "paragraph", Children: atLimit.Blocks}}}, "invalid_argument"},
		{"above size limit", Content{Text: strings.Repeat("x", maxPayload)}, "invalid_argument"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.content.Validate(); err == nil || publicError(err).Code != tc.code {
				t.Fatalf("validation = %v, want %s", err, tc.code)
			}
		})
	}
}

func TestGRPCAuthenticationAndPrivateMethods(t *testing.T) {
	c := testCore(t, nil)
	address, token := testServer(t, c)
	conn, err := grpc.NewClient("passthrough:///"+address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	must(t, err)
	defer conn.Close()
	client := pb.NewNotificationCoreClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = client.Call(ctx, &pb.Command{Method: "status"})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated access: %v", err)
	}
	bad := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer wrong", "nootify-node-id", "peer")
	_, err = client.Call(bad, &pb.Command{Method: "status"})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatal("wrong token accepted")
	}
	good := metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token, "nootify-node-id", "peer")
	result, err := client.Call(good, &pb.Command{Method: "config.export", ParamsJson: []byte(`{}`), VisitedNodes: []string{"peer"}})
	must(t, err)
	if result.ErrorCode != "permission_denied" || len(result.ResultJson) > 0 {
		t.Fatal("remote caller accessed private config")
	}
	_, err = client.Call(good, &pb.Command{Method: "session.ensure", ParamsJson: []byte(`{}`), VisitedNodes: []string{"peer", c.node()}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatal("command loop not stopped")
	}
	if validateRemote(RemoteConfig{Enabled: true, Listen: "0.0.0.0:9418", Token: token}) == nil {
		t.Fatal("public plaintext listener accepted")
	}
}
func addRemote(t *testing.T, c *Core, id, address, token string) *remoteProvider {
	t.Helper()
	cfg := ProviderConfig{ID: id, Name: id, Type: "remote", Enabled: true, Address: address, Token: token}
	must(t, c.store.Update(func(d *State) error { d.Providers[id] = cfg; d.DefaultProvider = id; return nil }))
	p := newRemoteProvider(c, cfg)
	c.mu.Lock()
	c.providers[id] = p
	c.mu.Unlock()
	go func() {
		_ = p.Subscribe(c.ctx, func(ctx context.Context, e Event) error { return c.Ingest(ctx, e, id) })
	}()
	return p
}
func TestRemoteMultiHopFullRefLegacyReturnPathAndLoops(t *testing.T) {
	a := testCore(t, nil)
	fake := installFake(t, a, "feishu-origin")
	addrA, tokenA := testServer(t, a)
	b := testCore(t, nil)
	addRemote(t, b, "upstream-a", addrA, tokenA)
	addrB, tokenB := testServer(t, b)
	delivered := make(chan map[string]any, 4)
	c := testCore(t, func(event string, data any) error {
		if event == "delivery" {
			delivered <- data.(map[string]any)
		}
		return nil
	})
	addRemote(t, c, "upstream-b", addrB, tokenB)
	await(t, func() bool { return len(a.store.Snapshot().Peers) == 1 && len(b.store.Snapshot().Peers) == 1 })
	session := Session{NodeID: c.node(), Adapter: "codex", SessionID: "on-c"}
	binding, err := c.Ensure(context.Background(), "", session)
	must(t, err)
	if binding.Session.NodeID != c.node() {
		t.Fatal("origin session identity changed")
	}
	ref := MessageRef{OriginNodeID: a.node(), ProviderID: "feishu-origin", MessageID: "incoming"}
	event := Event{ID: "across-hops", Session: session, Message: ref, Content: Content{Text: "hello"}, Hops: 16}
	must(t, a.Ingest(context.Background(), event, ""))
	select {
	case data := <-delivered:
		if data["message"].(MessageRef) != ref {
			t.Fatal("relay changed reference")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("multi-hop event not delivered")
	}
	resolved, err := c.Resolve(nil, ref.MessageID)
	must(t, err)
	_, err = c.Ack(context.Background(), resolved)
	must(t, err)
	fake.mu.Lock()
	acked := fake.lastAck
	fake.mu.Unlock()
	if acked != ref {
		t.Fatal("legacy ack did not reach origin provider")
	}
	reply, err := c.Reply(context.Background(), resolved, Content{Blocks: []ContentBlock{{Type: "code", Text: "answer"}}}, "reply-request")
	must(t, err)
	if reply.Message.OriginNodeID != a.node() {
		t.Fatal("reply origin was not retained")
	}
	_, err = c.Ack(context.Background(), reply.Message)
	must(t, err)
	must(t, c.Ingest(context.Background(), event, "another-route"))
	select {
	case <-delivered:
		t.Fatal("duplicate multi-route local execution")
	default:
	} // An explicit visited-node cycle must not enqueue or execute again.
	event.Visited = []string{a.node(), b.node(), c.node()}
	must(t, a.Ingest(context.Background(), event, ""))
	if fake.ensures != 1 {
		t.Fatal("session operations were broadcast")
	}
}
func TestConfigSecretsBackupValidationAndMigration(t *testing.T) {
	c := testCore(t, nil)
	raw := json.RawMessage(`{"id":"bot","name":"Feishu","type":"feishu","enabled":false,"app_id":"app","app_secret":"do-not-print","recipient_open_id":"user"}`)
	_, err := c.SaveProvider(raw)
	must(t, err)
	_, err = c.SaveProvider(json.RawMessage(`{"id":"bot","name":"Renamed","type":"feishu","enabled":false,"app_id":"app","app_secret":""}`))
	must(t, err)
	if c.store.Snapshot().Providers["bot"].AppSecret != "do-not-print" {
		t.Fatal("blank secret replaced existing secret")
	}
	summary, _ := json.Marshal(c.Status())
	if strings.Contains(string(summary), "do-not-print") {
		t.Fatal("status leaked a credential")
	}
	backup := c.ExportConfig()
	if backup.Providers[0].AppSecret != "do-not-print" {
		t.Fatal("private backup omitted secret")
	}
	before := c.store.Snapshot()
	invalid := Backup{Version: 1, Providers: backup.Providers, Default: "missing", Remote: before.Remote}
	doc, _ := json.Marshal(invalid)
	if c.ImportConfig(doc) == nil {
		t.Fatal("invalid backup imported")
	}
	if c.store.Snapshot().DefaultProvider != before.DefaultProvider {
		t.Fatal("invalid backup partially applied")
	}
	_, err = c.Handle(context.Background(), "config.export", json.RawMessage(`{}`), false)
	if publicError(err).Code != "permission_denied" {
		t.Fatal("private export available remotely")
	}
	c.cancel() // Migration is tested without dialing a real Feishu endpoint.
	migrate := json.RawMessage(`{"app_id":"legacy-app","app_secret":"legacy-secret","legacy_host":"old-host","bindings":[{"chat_id":"existing-group","session_id":"original-id","adapter":"codex","session_name":"Original","metadata":{"custom":"kept"}}]}`)
	_, err = c.Migrate(migrate)
	must(t, err)
	key := (Session{NodeID: c.node(), Adapter: "codex", SessionID: "original-id"}).key()
	b := c.store.Snapshot().Bindings[key]
	if b.ChatID != "existing-group" || b.Session.Metadata["custom"] != "kept" || b.Session.Metadata["legacy_host"] != "old-host" {
		t.Fatal("migration changed group, identity or metadata")
	}
	must(t, c.DeleteProvider("legacy-feishu"))
	_, err = c.Migrate(migrate)
	must(t, err)
	if _, ok := c.store.Snapshot().Providers["legacy-feishu"]; ok {
		t.Fatal("migration resurrected a deleted provider")
	}
}
func TestStdioRemainsConcurrentDuringTunnelDial(t *testing.T) {
	c := testCore(t, nil)
	p := installFake(t, c, "wait")
	must(t, c.store.Update(func(d *State) error { d.Tailnet = true; delete(d.Providers, "wait"); return nil }))
	listener := testPrivateTunnelListener(t)
	var err error
	p.ensure = func(ctx context.Context, s Session) (Binding, error) {
		conn, err := c.dial(ctx, "100.100.100.100:9418")
		if err != nil {
			return Binding{}, err
		}
		conn.Close()
		return Binding{Session: s, ChatID: "tunnel-group"}, nil
	}
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- serveStdio(context.Background(), c, inReader, outWriter); outWriter.Close() }()
	scanner := bufio.NewScanner(outReader)
	if !scanner.Scan() {
		t.Fatal("no ready frame")
	}
	// A status round trip proves Start has finished before installing the
	// configured fixture bot. The Ensure then follows the real provider path.
	_, err = fmt.Fprintln(inWriter, `{"id":99,"method":"status","params":{}}`)
	must(t, err)
	if !scanner.Scan() {
		t.Fatal("no startup status response")
	}
	var startup rpcResponse
	must(t, json.Unmarshal(scanner.Bytes(), &startup))
	if startup.ID != 99 || startup.Error != nil {
		t.Fatal("startup status failed")
	}
	must(t, c.store.Update(func(d *State) error {
		d.Providers["wait"] = ProviderConfig{ID: "wait", Name: "wait", Type: "feishu", AppID: "app", AppSecret: "private", Enabled: true}
		return nil
	}))
	c.mu.Lock()
	c.providers["wait"] = p
	c.mu.Unlock()
	_, err = fmt.Fprintln(inWriter, `{"id":1,"method":"session.ensure","params":{"provider_id":"wait","session":{"adapter":"codex","session_id":"s"}}}`)
	must(t, err)
	if !scanner.Scan() {
		t.Fatal("no dial event")
	}
	var event struct {
		Event string `json:"event"`
		Data  struct {
			RequestID string `json:"request_id"`
		} `json:"data"`
	}
	must(t, json.Unmarshal(scanner.Bytes(), &event))
	if event.Event != "dial" {
		t.Fatalf("expected dial, got %s", scanner.Text())
	}
	token := strings.Repeat("ab", 32)
	handshake := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			handshake <- err
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		frame := make([]byte, len(embeddedTunnelHandshakePrefix)+len(token)+1)
		_, err = io.ReadFull(conn, frame)
		if err == nil && string(frame) != embeddedTunnelHandshakePrefix+token+"\n" {
			err = fmt.Errorf("unexpected private tunnel handshake")
		}
		if err == nil {
			_, err = conn.Write([]byte{1})
		}
		handshake <- err
	}()
	complete, _ := json.Marshal(map[string]any{"id": 2, "method": "dial.complete", "params": map[string]any{"request_id": event.Data.RequestID, "address": listener.Addr().String(), "token": token, "network": localTunnelNetwork}})
	_, err = fmt.Fprintln(inWriter, string(complete))
	must(t, err)
	seen := map[int64]bool{}
	for len(seen) < 2 {
		if !scanner.Scan() {
			t.Fatal("response missing")
		}
		var response rpcResponse
		must(t, json.Unmarshal(scanner.Bytes(), &response))
		if response.Error != nil {
			t.Fatalf("stdio operation failed: %v", response.Error)
		}
		seen[response.ID] = true
	}
	must(t, <-handshake)
	inWriter.Close()
	select {
	case err := <-done:
		must(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("EOF did not stop core")
	}
}
