package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	im "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func privateFeishu(t *testing.T, c *Core, cfg ProviderConfig, handler http.HandlerFunc) *feishuProvider {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "tenant_access_token") {
			fmt.Fprint(w, `{"code":0,"tenant_access_token":"private-recovery-fixture","expire":3600}`)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	p := newFeishu(c, cfg)
	p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
	p.receiver = func(ctx context.Context, e Event) error { return c.Ingest(ctx, e, cfg.ID) }
	installRoutingBot(c, cfg.ID, p)
	must(t, c.store.Update(func(d *State) error { d.Providers[cfg.ID] = cfg; return nil }))
	t.Cleanup(func() { _ = p.Close() })
	return p
}

func feishuInput(id, chat, sender string) *im.P2MessageReceiveV1 {
	return &im.P2MessageReceiveV1{Event: &im.P2MessageReceiveV1Data{
		Sender:  &im.EventSender{SenderType: str("user"), SenderId: &im.UserId{OpenId: str(sender)}},
		Message: &im.EventMessage{MessageId: str(id), ChatId: str(chat), MessageType: str("text"), Content: str(`{"text":"private input"}`)},
	}}
}

func TestFeishuAdoptionPreservesDescriptionsAndAlwaysValidatesAnnouncement(t *testing.T) {
	for _, managed := range []bool{false, true} {
		t.Run(fmt.Sprintf("managed=%t", managed), func(t *testing.T) {
			var deliveries atomic.Int32
			c := testCore(t, func(name string, _ any) error {
				if name == "delivery" {
					deliveries.Add(1)
				}
				return nil
			})
			s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "adopted", Metadata: map[string]any{"legacy_host": "old-host"}}
			description := "Human description retained verbatim"
			if managed {
				description = sessionDescription(s)
			}
			var conflict atomic.Bool
			conflict.Store(true)
			var writes atomic.Int32
			cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "adoption-recovery-app", AppSecret: "synthetic", Recipient: "trusted"}
			p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					writes.Add(1)
					t.Errorf("adoption wrote group content: %s", r.Method)
				}
				if strings.HasSuffix(r.URL.Path, "/announcement") {
					marker := "agent-session:v1:old-host:codex:adopted"
					if conflict.Load() {
						marker = "agent-session:v1:old-host:codex:other"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"content": marker}})
				} else {
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"description": description}})
				}
			})
			_, err := c.Bind(context.Background(), "bot", s, "chat", "trusted")
			if publicError(err).Code != "conflict" {
				t.Fatalf("conflicting announcement accepted: %v", err)
			}
			conflict.Store(false)
			b, err := c.Bind(context.Background(), "bot", s, "chat", "trusted")
			must(t, err)
			if !b.PreserveDescription {
				t.Fatal("adopted description preservation not persisted")
			}
			_, err = c.SetMetadata(context.Background(), "bot", s, map[string]any{"note": "local metadata"})
			must(t, err)
			must(t, p.receive(context.Background(), feishuInput("accepted", "chat", "trusted")))
			conflict.Store(true)
			if err := p.receive(context.Background(), feishuInput("blocked", "chat", "trusted")); publicError(err).Code != "conflict" {
				t.Fatalf("changed legacy announcement routed input: %v", err)
			}
			_, err = c.Bind(context.Background(), "bot", s, "chat", "trusted")
			if publicError(err).Code != "conflict" {
				t.Fatalf("idempotent adoption bypassed revalidation: %v", err)
			}
			if deliveries.Load() != 1 || writes.Load() != 0 {
				t.Fatal("human metadata changed or conflicting input executed")
			}
		})
	}
}

func TestFeishuAdoptionPersistenceFailureCannotOverwriteHumanDescription(t *testing.T) {
	c := testCore(t, nil)
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "failed-adoption-app", AppSecret: "synthetic", Recipient: "trusted"}
	var writes atomic.Int32
	privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes.Add(1)
		}
		if strings.HasSuffix(r.URL.Path, "/announcement") {
			fmt.Fprint(w, `{"code":0,"data":{"content":"Human announcement"}}`)
		} else {
			fmt.Fprint(w, `{"code":0,"data":{"description":"Human description"}}`)
		}
	})
	originalDir := c.store.dir
	c.store.dir = filepath.Join(t.TempDir(), "missing-parent")
	defer func() { c.store.dir = originalDir }()
	_, err := c.Bind(context.Background(), "bot", Session{Adapter: "codex", SessionID: "not-persisted"}, "chat", "trusted")
	if err == nil || writes.Load() != 0 || len(c.store.Snapshot().Bindings) != 0 {
		t.Fatal("failed adoption changed external content or published a binding")
	}
}

func TestMigrationPreservesDuplicateChatsAndUsesEnabledSameAppOwner(t *testing.T) {
	var deliveries atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			deliveries.Add(1)
		}
		return nil
	})
	var deleted atomic.Int32
	cfg := ProviderConfig{ID: "active", Name: "Active", Type: "feishu", Enabled: true, AppID: "migration-app", AppSecret: "synthetic", Recipient: "default"}
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/open-apis/im/v1/messages" {
			fmt.Fprint(w, `{"code":0,"data":{"message_id":"active-owner-progress"}}`)
			return
		}
		if r.Method == "DELETE" {
			deleted.Add(1)
		}
		if strings.HasSuffix(r.URL.Path, "/announcement") {
			fmt.Fprint(w, `{"code":0,"data":{"content":"agent-session:v1:old-host:codex:shared"}}`)
		} else {
			fmt.Fprint(w, `{"code":0,"data":{}}`)
		}
	})
	raw := json.RawMessage(`{"app_id":"migration-app","app_secret":"old-synthetic","recipient_open_id":"default","legacy_host":"old-host","bindings":[{"chat_id":"one","session_id":"shared","adapter":"codex","sender_open_id":"first","history_cursor":1700000000000},{"chat_id":"two","session_id":"shared","adapter":"codex","sender_open_id":"second","history_cursor":1700000000001},{"chat_id":"unrelated","session_id":"other","adapter":"trae"}]}`)
	_, err := c.Migrate(raw)
	must(t, err)
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "shared"}
	b := c.store.Snapshot().Bindings[s.key()]
	if b.ProviderID != "active" || len(b.Aliases) != 1 || b.Aliases[0].ChatID != "two" || b.Aliases[0].SenderID != "second" || len(c.store.Snapshot().Bindings) != 2 {
		t.Fatalf("duplicate migration lost groups or owner: %+v", b)
	}
	if c.store.Snapshot().FeishuCursors[feishuCursorKey(cfg.AppID, "two")] != 1700000000001 {
		t.Fatal("legacy whole-chat cursor was not preserved")
	}
	_, err = c.Ensure(context.Background(), "", s)
	must(t, err)
	sent, err := c.Send(context.Background(), "", s, Content{Text: "progress"}, "migration-proof")
	must(t, err)
	if sent.Message.ProviderID != "active" || sent.ChatID != "one" {
		t.Fatal("migrated group cannot send through its enabled owner")
	}
	_, err = c.SetMetadata(context.Background(), "", s, map[string]any{"custom": "retained locally"})
	must(t, err)
	must(t, p.receive(context.Background(), feishuInput("first-message", "one", "first")))
	must(t, p.receive(context.Background(), feishuInput("wrong-sender", "two", "first")))
	must(t, p.receive(context.Background(), feishuInput("second-message", "two", "second")))
	if deliveries.Load() != 2 {
		t.Fatal("alias trust or routing was lost")
	}
	must(t, c.Delete(context.Background(), "", s))
	if deleted.Load() != 2 || len(c.store.Snapshot().RetiredBindings) != 2 {
		t.Fatal("notification deletion did not clean up and retire every legacy chat")
	}
	must(t, p.receive(context.Background(), feishuInput("late", "two", "second")))
	if deliveries.Load() != 2 {
		t.Fatal("deleted alias executed late input")
	}
}

func TestRetryDeliveryContextExpiresWithoutDispatching(t *testing.T) {
	var count atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			count.Add(1)
		}
		return nil
	})
	e := eventFor(c.node(), "cancel-retry")
	must(t, c.Ingest(context.Background(), e, ""))
	id := ""
	for key := range c.store.Snapshot().Deliveries {
		id = key
	}
	must(t, c.Complete(id, "retryable", "offline", ""))
	unlock, err := c.sessions.acquire(context.Background(), e.Session.key())
	must(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.RetryDeliveryContext(ctx, id) }()
	if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued retry ignored request context: %v", err)
	}
	unlock()
	if count.Load() != 1 || c.store.Snapshot().Deliveries[id].Status != "retryable" {
		t.Fatal("expired request changed delivery state or submitted input")
	}
}

func TestFeishuPostsRoundTripNestedBoundaries(t *testing.T) {
	for _, content := range []Content{
		{Text: "prefix", Blocks: []ContentBlock{{Type: "paragraph", Text: "suffix"}}},
		{Blocks: []ContentBlock{{Type: "paragraph", Children: []ContentBlock{{Type: "paragraph", Text: "nested"}, {Type: "text", Text: "tail"}}}}},
		{Blocks: []ContentBlock{{Type: "paragraph", Children: []ContentBlock{{Type: "paragraph", Text: "nested"}}}}},
		{Blocks: []ContentBlock{{Type: "code", Text: "code"}, {Type: "text", Text: "tail"}}},
		{Text: "prefix", Blocks: []ContentBlock{{Type: "code", Text: "code"}}},
		{Blocks: []ContentBlock{{Type: "paragraph", Children: []ContentBlock{{Type: "link", Text: "guide", URL: "https://example.com"}, {Type: "code", Text: "code"}, {Type: "text", Text: "tail"}}}}},
	} {
		kind, raw, err := toFeishu(content)
		must(t, err)
		got, err := fromFeishu(kind, raw)
		must(t, err)
		if got.Plain() != content.Plain() {
			t.Errorf("post changed text boundaries: got=%q want=%q wire=%s", got.Plain(), content.Plain(), raw)
		}
	}
}
