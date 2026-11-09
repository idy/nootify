package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	im "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func TestFeishuIngressRequiresRetainedAuthorizedBinding(t *testing.T) {
	for _, tc := range []struct {
		name, providerType, app, chat, trusted, sender, recipient string
		bound, deleted, accepted                                  bool
	}{
		{name: "description targets unbound session", sender: "default"},
		{name: "description targets session in another chat", bound: true, providerType: "feishu", app: "ingress-app", chat: "other-chat", sender: "default"},
		{name: "description targets session on another bot", bound: true, providerType: "feishu", app: "other-app", chat: "incoming-chat", sender: "default"},
		{name: "description targets remote binding", bound: true, providerType: "remote", chat: "incoming-chat", sender: "default"},
		{name: "deleted binding", bound: true, deleted: true, providerType: "feishu", app: "ingress-app", chat: "incoming-chat", sender: "default"},
		{name: "binding overrides default trusted sender", bound: true, providerType: "feishu", app: "ingress-app", chat: "incoming-chat", trusted: "custom", sender: "default"},
		{name: "bound custom trusted sender", bound: true, providerType: "feishu", app: "ingress-app", chat: "incoming-chat", trusted: "custom", sender: "custom", accepted: true},
		{name: "bound default trusted sender", bound: true, providerType: "feishu", app: "ingress-app", chat: "incoming-chat", sender: "default", accepted: true},
		{name: "same app alias cannot substitute its trusted sender", bound: true, providerType: "feishu", app: "ingress-app", chat: "incoming-chat", recipient: "owner-default", sender: "default"},
		{name: "same app alias uses binding owner's trusted sender", bound: true, providerType: "feishu", app: "ingress-app", chat: "incoming-chat", recipient: "owner-default", sender: "owner-default", accepted: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var callbacks, deliveries, requests atomic.Int32
			c := testCore(t, func(name string, _ any) error {
				if name == "delivery" {
					deliveries.Add(1)
				}
				return nil
			})
			s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "target"}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.Contains(r.URL.Path, "tenant_access_token") {
					fmt.Fprint(w, `{"code":0,"tenant_access_token":"ingress-private-fixture-token","expire":3600}`)
					return
				}
				requests.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"description": sessionDescription(s)}})
			}))
			defer server.Close()
			cfg := ProviderConfig{ID: "feed", Type: "feishu", AppID: "ingress-app", AppSecret: "fixture", Recipient: "default"}
			p := newFeishu(c, cfg)
			defer p.Close()
			p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
			p.receiver = func(ctx context.Context, e Event) error {
				callbacks.Add(1)
				return c.Ingest(ctx, e, cfg.ID)
			}
			must(t, c.store.Update(func(d *State) error {
				d.Providers[cfg.ID] = cfg
				// A second configured feed for the same app is allowed to observe an
				// authorized resource; a different bot or remote provider is not.
				recipient := tc.recipient
				if recipient == "" {
					recipient = "default"
				}
				d.Providers["owner"] = ProviderConfig{ID: "owner", Type: tc.providerType, AppID: tc.app, Recipient: recipient}
				if tc.bound {
					d.Bindings[s.key()] = Binding{ProviderID: "owner", Session: s, ChatID: tc.chat, SenderID: tc.trusted, Deleted: tc.deleted}
				}
				return nil
			}))
			payload := &im.P2MessageReceiveV1{Event: &im.P2MessageReceiveV1Data{
				Sender:  &im.EventSender{SenderType: str("user"), SenderId: &im.UserId{OpenId: str(tc.sender)}},
				Message: &im.EventMessage{MessageId: str("incoming"), ChatId: str("incoming-chat"), MessageType: str("text"), Content: str(`{"text":"private fixture"}`)},
			}}
			must(t, p.receive(context.Background(), payload))
			want := int32(0)
			if tc.accepted {
				want = 1
			}
			if callbacks.Load() != want || deliveries.Load() != want || len(c.store.Snapshot().References) != int(want) {
				t.Fatalf("ingress accepted without matching authority: callbacks=%d deliveries=%d references=%d", callbacks.Load(), deliveries.Load(), len(c.store.Snapshot().References))
			}
			if requests.Load() != 0 {
				t.Fatal("ingress consulted group-controlled metadata for authorization")
			}
		})
	}
}

func TestSuppressedCopiesCannotInstallReturnRoutes(t *testing.T) {
	for _, mode := range []string{"expired", "visited"} {
		t.Run(mode, func(t *testing.T) {
			c := testCore(t, nil)
			bad := installFake(t, c, "invalid-route")
			good := installFake(t, c, "valid-route")
			e := eventFor(c.node(), "route-proof")
			suppressed := e
			if mode == "expired" {
				suppressed.Hops = 0
			} else {
				suppressed.Visited = []string{c.node()}
			}
			must(t, c.Ingest(context.Background(), suppressed, bad.id))
			if len(c.store.Snapshot().References) != 0 || len(c.store.Snapshot().Events) != 0 {
				t.Fatal("suppressed copy retained identity or a return route")
			}
			must(t, c.Ingest(context.Background(), e, good.id))
			must(t, c.Ingest(context.Background(), suppressed, bad.id))
			r := c.store.Snapshot().References[e.Message.key()]
			if len(r.Routes) != 1 || r.Routes[0] != good.id {
				t.Fatalf("suppressed duplicate installed return path: %v", r.Routes)
			}
			_, err := c.Reply(context.Background(), e.Message, Content{Text: "answer"}, "proof")
			must(t, err)
			if bad.replies != 0 || good.replies != 1 {
				t.Fatal("reply used a route that never validly handled the event")
			}
		})
	}
}

type acknowledgmentRoutingBot struct {
	Bot
	ack func(context.Context, MessageRef) error
}

func (p *acknowledgmentRoutingBot) Ack(ctx context.Context, m MessageRef) error {
	return p.ack(ctx, m)
}

func TestConcurrentAcknowledgmentsUseFullReferenceWithoutGlobalRPCGate(t *testing.T) {
	upstream := testCore(t, nil)
	base := installFake(t, upstream, "bot")
	other := installFake(t, upstream, "other-bot")
	entered, release := make(chan struct{}, 1), make(chan struct{})
	var calls atomic.Int32
	gated := &acknowledgmentRoutingBot{Bot: base, ack: func(ctx context.Context, m MessageRef) error {
		calls.Add(1)
		if err := barrierCall(ctx, entered, release); err != nil {
			return err
		}
		return base.Ack(ctx, m)
	}}
	installRoutingBot(upstream, "bot", gated)
	address, token := testServer(t, upstream)
	downstream := testCore(t, nil)
	local := installFake(t, downstream, "bot")
	addRemote(t, downstream, "upstream", address, token)
	remoteRef := MessageRef{OriginNodeID: upstream.node(), ProviderID: "bot", MessageID: "same-message"}
	otherRef := remoteRef
	otherRef.ProviderID = "other-bot"
	localRef := remoteRef
	localRef.OriginNodeID = downstream.node()
	must(t, downstream.store.Update(func(d *State) error {
		remember(d, remoteRef, "upstream")
		remember(d, otherRef, "upstream")
		return nil
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	type result struct {
		data map[string]any
		err  error
	}
	const concurrent = 12
	results := make(chan result, concurrent)
	for i := 0; i < concurrent; i++ {
		go func() { data, err := downstream.Ack(ctx, remoteRef); results <- result{data, err} }()
	}
	waitRouting(t, entered)
	// All duplicate callers share exactly this reference's gate, including while
	// its provider is executing an actual authenticated loopback gRPC command.
	await(t, func() bool {
		downstream.acks.mu.Lock()
		defer downstream.acks.mu.Unlock()
		entry := downstream.acks.entries[remoteRef.key()]
		return entry != nil && entry.refs == concurrent
	})
	if calls.Load() != 1 {
		t.Fatal("concurrent acknowledgments submitted duplicate RPCs")
	}
	_, err := downstream.Ack(ctx, localRef)
	must(t, err)
	_, err = downstream.Ack(ctx, otherRef)
	must(t, err)
	_, err = downstream.Ensure(ctx, "bot", Session{Adapter: "codex", SessionID: "independent"})
	must(t, err)
	if local.acks != 1 || other.acks != 1 || ctx.Err() != nil {
		t.Fatal("an acknowledgment blocked another origin/provider or an unrelated session")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	_, err = downstream.Ack(canceled, remoteRef)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled acknowledgment waiter = %v", err)
	}
	close(release)
	stamp := ""
	for i := 0; i < concurrent; i++ {
		got := <-results
		must(t, got.err)
		at, _ := got.data["acknowledged_at"].(string)
		if at == "" || stamp != "" && at != stamp {
			t.Fatal("duplicate acknowledgments did not share the durable receipt")
		}
		stamp = at
	}
	if calls.Load() != 1 || base.acks != 1 {
		t.Fatal("full-reference acknowledgment was not submitted exactly once")
	}
	downstream.acks.mu.Lock()
	remaining := len(downstream.acks.entries)
	downstream.acks.mu.Unlock()
	if remaining != 0 {
		t.Fatal("completed acknowledgment gates leaked")
	}
	downstream = reopenCore(t, downstream, nil)
	data, err := downstream.Ack(ctx, remoteRef)
	must(t, err)
	if data["acknowledged_at"] != stamp || calls.Load() != 1 {
		t.Fatal("restart lost the durable acknowledgment receipt")
	}
}

func TestRetryDispatchAndDeleteShareSessionGate(t *testing.T) {
	for _, mode := range []string{"explicit", "ingress replay"} {
		t.Run(mode, func(t *testing.T) {
			entered, release := make(chan struct{}, 1), make(chan struct{})
			var emissions atomic.Int32
			c := testCore(t, func(name string, _ any) error {
				if name == "delivery" && emissions.Add(1) == 2 {
					return barrierCall(context.Background(), entered, release)
				}
				return nil
			})
			installFake(t, c, "bot")
			s := Session{Adapter: "codex", SessionID: "retry-delete"}
			binding, err := c.Ensure(context.Background(), "bot", s)
			must(t, err)
			e := eventFor(c.node(), "retry-delete")
			e.Session = binding.Session
			must(t, c.Ingest(context.Background(), e, ""))
			id := ""
			for key := range c.store.Snapshot().Deliveries {
				id = key
			}
			must(t, c.Complete(id, "retryable", "offline", ""))
			retry := func() error {
				if mode == "explicit" {
					return c.RetryDelivery(id)
				}
				return c.Ingest(context.Background(), e, "")
			}
			result := make(chan error, 1)
			go func() { result <- retry() }()
			waitRouting(t, entered)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			t.Cleanup(func() {
				select {
				case <-release:
				default:
					close(release)
				}
			})
			deleted := make(chan error, 1)
			go func() { deleted <- c.Delete(ctx, "bot", s) }()
			await(t, func() bool {
				c.sessions.mu.Lock()
				defer c.sessions.mu.Unlock()
				entry := c.sessions.entries[binding.Session.key()]
				return entry != nil && entry.refs == 2
			})
			select {
			case err := <-deleted:
				t.Fatalf("deletion completed during retry dispatch: %v", err)
			default:
			}
			// The held session gate does not serialize unrelated sessions.
			_, err = c.Ensure(ctx, "bot", Session{Adapter: "codex", SessionID: "unrelated-retry"})
			must(t, err)
			close(release)
			must(t, <-result)
			must(t, <-deleted)
			must(t, c.Complete(id, "retryable", "offline", ""))
			if err := c.RetryDelivery(id); publicError(err).Code != "deleted" {
				t.Fatalf("completed deletion permitted explicit retry: %v", err)
			}
			must(t, c.Ingest(ctx, e, ""))
			if emissions.Load() != 2 || c.store.Snapshot().Events[e.ID].Outcome != "deleted" {
				t.Fatal("completed deletion permitted replay dispatch")
			}
		})
	}
}

func TestSameBindingRejectsConflictingExplicitTrustedSender(t *testing.T) {
	c := testCore(t, nil)
	bot := &adoptingBot{fakeProvider: installFake(t, c, "bot")}
	installRoutingBot(c, "bot", bot)
	s := Session{Adapter: "codex", SessionID: "same-binding"}
	first, err := c.Bind(context.Background(), "bot", s, "same-chat", "trusted")
	must(t, err)
	for _, sender := range []string{"", "trusted"} {
		got, err := c.Bind(context.Background(), "bot", s, "same-chat", sender)
		must(t, err)
		if got.SenderID != first.SenderID {
			t.Fatal("idempotent bind changed trusted sender")
		}
	}
	_, err = c.Bind(context.Background(), "bot", s, "same-chat", "different-sender")
	if publicError(err).Code != "conflict" || bot.binds != 1 || c.store.Snapshot().Bindings[first.Session.key()].SenderID != "trusted" {
		t.Fatal("conflicting trusted sender was silently accepted or updated")
	}
}

func TestAdoptionRecognizesAllRetainedLegacyDeclarations(t *testing.T) {
	const uuid = "12345678-1234-1234-1234-123456789abc"
	const otherUUID = "abcdefab-abcd-abcd-abcd-abcdefabcdef"
	desktop, codex, openCode := "local_"+uuid, uuid, "ses_original123"
	explicit := "agent-session:v1:legacy-host:codex:" + uuid
	for _, tc := range []struct {
		name, adapter, id, text string
		conflict                bool
	}{
		{"Desktop bare matching", "claude-desktop", desktop, desktop, false},
		{"Desktop labeled matching", "claude-desktop", desktop, "Claude 会话 " + desktop, false},
		{"Desktop conflicting ID", "claude-desktop", desktop, "local_" + otherUUID, true},
		{"Desktop conflicting adapter", "codex", desktop, desktop, true},
		{"Codex thread matching", "codex", codex, "Codex thread " + uuid, false},
		{"Codex session colon matching", "codex", codex, "CODEX session: " + uuid, false},
		{"Codex Chinese matching", "codex", codex, "Codex 会话：" + uuid, false},
		{"Codex conflicting ID", "codex", codex, "Codex thread " + otherUUID, true},
		{"Codex Unicode whitespace conflict", "codex", codex, "Codex thread　" + otherUUID, true},
		{"Codex conflicting adapter", "claude-code", codex, "Codex thread " + uuid, true},
		{"OpenCode session matching", "opencode", openCode, "OpenCode session " + openCode, false},
		{"Open Code Chinese matching", "opencode", openCode, "Open Code 会话：" + openCode, false},
		{"OpenCode conflicting ID", "opencode", openCode, "OpenCode thread ses_other456", true},
		{"OpenCode conflicting adapter", "codex", openCode, "OpenCode session " + openCode, true},
		{"explicit matching", "codex", codex, explicit, false},
		{"explicit and matching label", "codex", codex, explicit + "\nCodex thread " + uuid, false},
		{"duplicate explicit marker", "codex", codex, explicit + "\n" + explicit, false},
		{"explicit and conflicting label", "codex", codex, explicit + "\nCodex thread " + otherUUID, true},
		{"two labeled sessions", "codex", codex, "Codex thread " + uuid + "\nCodex session " + otherUUID, true},
		{"different explicit hosts are ambiguous", "codex", codex, explicit + "\nagent-session:v1:node:codex:" + uuid, true},
		{"explicit wrong host", "codex", codex, "agent-session:v1:someone-else:codex:" + uuid, true},
		{"different declaration forms are ambiguous", "codex", codex, "Codex thread " + uuid + "\nOpenCode session " + openCode, true},
		{"Desktop marker and repeated bare ID", "claude-desktop", desktop, "agent-session:v1:legacy-host:claude-desktop:" + desktop + "\n" + desktop, false},
		{"no declaration may be explicitly adopted", "codex", codex, "Original human announcement", false},
	} {
		for _, styled := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/styled=%t", tc.name, styled), func(t *testing.T) {
				var announcement any = tc.text
				if styled {
					mid := len(tc.text) / 2
					announcement = map[string]any{"elements": []any{
						map[string]any{"text_run": map[string]any{"content": tc.text[:mid]}},
						map[string]any{"text_run": map[string]any{"content": tc.text[mid:]}},
					}}
				}
				var patches atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					var data any
					switch {
					case strings.Contains(r.URL.Path, "tenant_access_token"):
						fmt.Fprint(w, `{"code":0,"tenant_access_token":"adoption-private-fixture-token","expire":3600}`)
						return
					case r.Method == "GET" && r.URL.Path == "/open-apis/im/v1/chats/group":
						data = map[string]any{"description": "Existing description"}
					case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/announcement"):
						data = map[string]any{"content": announcement}
					case r.Method == "PATCH" && r.URL.Path == "/open-apis/im/v1/chats/group":
						patches.Add(1)
						var body map[string]any
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 1 || body["description"] == nil {
							t.Error("adoption changed the original announcement")
						}
						data = map[string]any{}
					default:
						t.Errorf("unexpected adoption request: %s %s", r.Method, r.URL.Path)
						http.Error(w, "unexpected request", 400)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
				}))
				defer server.Close()
				c := testCore(t, nil)
				cfg := ProviderConfig{ID: "bot", AppID: "adoption-app", AppSecret: "fixture", Recipient: "trusted"}
				p := newFeishu(c, cfg)
				defer p.Close()
				p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
				s := Session{NodeID: "node", Adapter: tc.adapter, SessionID: tc.id, Metadata: map[string]any{"legacy_host": "legacy-host"}}
				_, err := p.Bind(context.Background(), s, "group", "")
				if tc.conflict {
					if publicError(err).Code != "conflict" || patches.Load() != 0 {
						t.Fatalf("conflicting declaration adopted: error=%v patches=%d", err, patches.Load())
					}
				} else {
					must(t, err)
					if patches.Load() != 0 {
						t.Fatal("adoption changed the existing group description")
					}
				}
			})
		}
	}
}
