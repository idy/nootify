package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	im "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func TestAutomaticEnrollmentAndSafeExplicitRetry(t *testing.T) {
	count := 0
	var deliveryID string
	c := testCore(t, func(event string, data any) error {
		if event == "delivery" {
			count++
			deliveryID = data.(map[string]any)["delivery_id"].(string)
		}
		return nil
	})
	p := installFake(t, c, "bot")
	s := Session{Adapter: "codex", SessionID: "deleted"}
	_, err := c.Ensure(context.Background(), "", s)
	must(t, err)
	must(t, c.Delete(context.Background(), "", s))
	raw, _ := json.Marshal(map[string]any{"session": s, "automatic": true})
	_, err = c.Handle(context.Background(), "session.ensure", raw, true)
	if publicError(err).Code != "deleted" || p.ensures != 1 {
		t.Fatal("automatic ensure resurrected deleted notification resources")
	}
	_, err = c.Ensure(context.Background(), "", s)
	must(t, err)
	event := eventFor(c.node(), "retry-safe")
	event.Session = c.normalize(s)
	must(t, c.Ingest(context.Background(), event, ""))
	if count != 1 {
		t.Fatal("delivery not emitted")
	}
	if c.RetryDelivery(deliveryID) == nil {
		t.Fatal("pending submission retried")
	}
	must(t, c.Complete(deliveryID, "retryable", "offline", ""))
	must(t, c.RetryDelivery(deliveryID))
	if count != 2 {
		t.Fatal("proven safe retry was not emitted")
	}
	must(t, c.Complete(deliveryID, "unconfirmed", "uncertain", ""))
	if c.RetryDelivery(deliveryID) == nil {
		t.Fatal("uncertain submission retried")
	}
}
func TestRemoteCycleStopsCommandsAndEvents(t *testing.T) {
	a := testCore(t, nil)
	b := testCore(t, nil)
	addrA, tokenA := testServer(t, a)
	addrB, tokenB := testServer(t, b)
	addRemote(t, a, "remote-b", addrB, tokenB)
	addRemote(t, b, "remote-a", addrA, tokenA)
	await(t, func() bool { return len(a.store.Snapshot().Peers) == 1 && len(b.store.Snapshot().Peers) == 1 })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := a.Ensure(ctx, "", Session{Adapter: "codex", SessionID: "cycle"})
	if err == nil || ctx.Err() != nil {
		t.Fatalf("command cycle did not fail promptly: %v", err)
	}
	must(t, a.Ingest(ctx, eventFor("elsewhere", "cycle-event"), ""))
	await(t, func() bool { _, ok := b.store.Snapshot().Events["cycle-event"]; return ok })
	if len(b.store.Snapshot().Peers[a.node()].Pending) != 0 {
		t.Fatal("event loop was sent back to visited origin")
	}
	if len(a.store.Snapshot().Events) != 1 {
		t.Fatal("event cycle produced duplicates")
	}
}
func TestAbandonedAtomicSnapshotIsCleanedAfterLock(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	must(t, err)
	node := s.Snapshot().NodeID
	stale := filepath.Join(dir, ".state-abandoned")
	must(t, os.WriteFile(stale, []byte("incomplete snapshot"), 0600))
	must(t, s.Close())
	s, err = OpenStore(dir)
	must(t, err)
	defer s.Close()
	if s.Snapshot().NodeID != node {
		t.Fatal("abandoned write changed stable identity")
	}
	if _, err = os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("abandoned atomic snapshot was not cleaned")
	}
}

func TestStoreRejectsLinksAndRollsBackFailedTransaction(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	must(t, err)
	before := s.Snapshot().NodeID
	err = s.Update(func(d *State) error { d.NodeID = "changed"; return fmt.Errorf("transaction canceled") })
	if err == nil || s.Snapshot().NodeID != before {
		t.Fatal("failed transaction changed state")
	}
	must(t, s.Close())
	other := filepath.Join(t.TempDir(), "outside")
	must(t, os.WriteFile(other, []byte("private"), 0600))
	must(t, os.Remove(filepath.Join(dir, "state.json")))
	if err = os.Symlink(other, filepath.Join(dir, "state.json")); err != nil {
		t.Skip("symlink creation is unavailable")
	}
	if opened, err := OpenStore(dir); err == nil {
		opened.Close()
		t.Fatal("symlinked state was read")
	}
}
func str(v string) *string { return &v }
func TestFeishuOfficialSDKRequestsAdoptionAndIngress(t *testing.T) {
	var mu sync.Mutex
	description := ""
	sawRich, sawReaction := false, false
	announcement := `{"content":"agent-session:v1:old-host:codex:existing"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "tenant_access_token") {
			fmt.Fprint(w, `{"code":0,"tenant_access_token":"fixture-token","expire":3600}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("SDK request was not authenticated")
		}
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == "POST" && r.URL.Path == "/open-apis/im/v1/chats":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			description, _ = body["description"].(string)
			fmt.Fprint(w, `{"code":0,"data":{"chat_id":"group"}}`)
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/announcement"):
			fmt.Fprintf(w, `{"code":0,"data":%s}`, announcement)
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/open-apis/im/v1/chats/"):
			body, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"description": description}})
			w.Write(body)
		case r.Method == "PATCH":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			description, _ = body["description"].(string)
			fmt.Fprint(w, `{"code":0,"data":{}}`)
		case strings.HasSuffix(r.URL.Path, "/reactions"):
			sawReaction = true
			fmt.Fprint(w, `{"code":0,"data":{}}`)
		case strings.HasPrefix(r.URL.Path, "/open-apis/im/v1/messages"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			content, _ := body["content"].(string)
			sawRich = body["msg_type"] == "post" && strings.Contains(content, "code_block") && strings.Contains(content, "href")
			fmt.Fprint(w, `{"code":0,"data":{"message_id":"result-message"}}`)
		default:
			fmt.Fprint(w, `{"code":0,"data":{}}`)
		}
	}))
	defer server.Close()
	count := 0
	c := testCore(t, func(name string, data any) error {
		if name == "delivery" {
			count++
		}
		return nil
	})
	cfg := ProviderConfig{ID: "feishu", Name: "fixture", Type: "feishu", AppID: "fixture-app", AppSecret: "fixture-secret", Recipient: "trusted", Enabled: false}
	p := newFeishu(c, cfg)
	p.receiver = func(ctx context.Context, e Event) error { return c.Ingest(ctx, e, cfg.ID) }
	p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
	c.providers[cfg.ID] = p
	must(t, c.store.Update(func(d *State) error { d.Providers[cfg.ID] = cfg; d.DefaultProvider = cfg.ID; return nil }))
	session := Session{NodeID: c.node(), Adapter: "codex", SessionID: "existing", Metadata: map[string]any{"legacy_host": "old-host", "custom": "retained"}} // Existing announcements remain untouched during explicit adoption.
	binding, err := c.Bind(context.Background(), "", session, "group", "trusted")
	must(t, err)
	if binding.ChatID != "group" {
		t.Fatal("existing group was replaced")
	}
	rich := Content{Blocks: []ContentBlock{{Type: "paragraph", Children: []ContentBlock{{Type: "link", Text: "guide", URL: "https://example.com"}}}, {Type: "code", Text: "answer"}}}
	sent, err := c.Send(context.Background(), "", session, rich, "request")
	must(t, err)
	if !sawRich {
		t.Fatal("SDK did not send an actual rich Feishu post")
	}
	_, err = c.Ack(context.Background(), sent.Message)
	must(t, err)
	if !sawReaction {
		t.Fatal("SDK did not create a Feishu receipt reaction")
	}
	payload := &im.P2MessageReceiveV1{Event: &im.P2MessageReceiveV1Data{Sender: &im.EventSender{SenderType: str("user"), SenderId: &im.UserId{OpenId: str("untrusted")}}, Message: &im.EventMessage{MessageId: str("incoming"), ChatId: str("group"), MessageType: str("text"), Content: str(`{"text":"reply"}`)}}}
	must(t, p.receive(context.Background(), payload))
	if count != 0 {
		t.Fatal("unauthorized sender admitted")
	}
	payload.Event.Sender.SenderId.OpenId = str("trusted")
	must(t, p.receive(context.Background(), payload))
	must(t, p.receive(context.Background(), payload))
	if count != 1 {
		t.Fatal("ingress duplicate or admission bug")
	}
	aliasConfig := cfg
	aliasConfig.ID = "alias"
	alias := newFeishu(c, aliasConfig)
	alias.receiver = func(ctx context.Context, e Event) error { return c.Ingest(ctx, e, aliasConfig.ID) }
	alias.client = p.client
	must(t, c.store.Update(func(d *State) error { d.Providers[aliasConfig.ID] = aliasConfig; return nil }))
	must(t, alias.receive(context.Background(), payload))
	if count != 1 {
		t.Fatal("two feeds from same bot executed same source twice")
	}
	mu.Lock()
	description = ""
	announcement = `{"content":"agent-session:v1:other-host:codex:other-session"}`
	mu.Unlock()
	_, err = p.Bind(context.Background(), session, "different-group", "trusted")
	if publicError(err).Code != "conflict" {
		t.Fatal("conflicting group metadata adopted")
	}
}
