package main

import (
	"context"
	"encoding/json"
	"errors"
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

func TestFeishuRepliesPreserveThreadAcrossRestartAndRemote(t *testing.T) {
	for _, thread := range []string{"", "omt-original"} {
		name := "ordinary-message"
		if thread != "" {
			name = "ordinary-group-thread"
		}
		t.Run(name, func(t *testing.T) {
			type replyRequest struct {
				Path     string
				InThread bool `json:"reply_in_thread"`
			}
			requests := make(chan replyRequest, 4)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.Contains(r.URL.Path, "tenant_access_token"):
					fmt.Fprint(w, `{"code":0,"tenant_access_token":"thread-fixture-token","expire":3600}`)
				case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/reply"):
					var request replyRequest
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Error(err)
					}
					request.Path = r.URL.Path
					requests <- request
					fmt.Fprint(w, `{"code":0,"data":{"message_id":"fixture-reply"}}`)
				case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/reactions"):
					fmt.Fprint(w, `{"code":0,"data":{}}`)
				default:
					t.Errorf("unexpected fixture request: %s %s", r.Method, r.URL.Path)
					http.Error(w, "unexpected request", http.StatusBadRequest)
				}
			}))
			defer server.Close()
			upstream := testCore(t, nil)
			deliveries := make(chan map[string]any, 1)
			downstream := testCore(t, func(name string, data any) error {
				if name == "delivery" {
					deliveries <- data.(map[string]any)
				}
				return nil
			})
			cfg := ProviderConfig{ID: "thread-bot", Type: "feishu", AppID: "thread-fixture-app", AppSecret: "fixture-secret", Recipient: "trusted"}
			attach := func(c *Core) *feishuProvider {
				p := newFeishu(c, cfg)
				p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
				p.receiver = func(ctx context.Context, e Event) error { return c.Ingest(ctx, e, cfg.ID) }
				c.providers[cfg.ID] = p
				return p
			}
			p := attach(upstream)
			session := Session{NodeID: downstream.node(), Adapter: "codex", SessionID: "thread-session"}
			must(t, upstream.store.Update(func(d *State) error {
				d.Providers[cfg.ID] = cfg // Disabled: no live WebSocket, including after restart.
				d.Bindings[session.key()] = Binding{ProviderID: cfg.ID, Session: session, ChatID: "ordinary-group", SenderID: "trusted"}
				return nil
			}))
			// Keep an offline subscriber so ingress is replayed from durable state.
			sub, err := upstream.Subscribe(context.Background(), downstream.node(), "fixture")
			must(t, err)
			sub.Close()
			// This fixture deliberately creates a pre-proof queue; authorize its real key locally.
			peerIdentity, err := json.Marshal(downstream.RemoteIdentity())
			must(t, err)
			_, err = upstream.BindPeer(peerIdentity)
			must(t, err)
			payload := &im.P2MessageReceiveV1{Event: &im.P2MessageReceiveV1Data{
				Sender:  &im.EventSender{SenderType: str("user"), SenderId: &im.UserId{OpenId: str("trusted")}},
				Message: &im.EventMessage{MessageId: str("incoming"), ChatId: str("ordinary-group"), ChatType: str("group"), ThreadId: str(thread), MessageType: str("text"), Content: str(`{"text":"question"}`)},
			}}
			must(t, p.receive(context.Background(), payload))
			upstream = reopenCore(t, upstream, nil)
			attach(upstream)
			address, token := testServer(t, upstream)
			addRemote(t, downstream, "upstream", address, token)
			var delivered MessageRef
			select {
			case data := <-deliveries:
				delivered = data["message"].(MessageRef)
			case <-time.After(5 * time.Second):
				t.Fatal("persisted ingress was not replayed over gRPC")
			}
			// Inspect the wire representation as well as the persisted return path.
			assertThread := func(ref MessageRef) {
				t.Helper()
				raw, err := json.Marshal(ref)
				must(t, err)
				var wire struct {
					ThreadID string `json:"thread_id"`
				}
				must(t, json.Unmarshal(raw, &wire))
				if wire.ThreadID != thread {
					t.Errorf("thread context = %q, want %q", wire.ThreadID, thread)
				}
			}
			assertThread(delivered)
			retained, err := upstream.Resolve(nil, "incoming")
			must(t, err)
			assertThread(retained)
			downstream = reopenCore(t, downstream, nil)
			addRemote(t, downstream, "upstream", address, token)
			resolved, err := downstream.Resolve(nil, "incoming")
			must(t, err)
			assertThread(resolved)
			// Old clients may supply only the three identity fields. Acknowledging
			// one must not erase the retained context used by later replies.
			minimal := MessageRef{OriginNodeID: delivered.OriginNodeID, ProviderID: delivered.ProviderID, MessageID: delivered.MessageID}
			if delivered.key() != minimal.key() {
				t.Fatal("thread context changed message identity")
			}
			normalized, err := downstream.Resolve(&minimal, "")
			must(t, err)
			assertThread(normalized)
			_, err = downstream.Ack(context.Background(), minimal)
			must(t, err)
			resolved, err = downstream.Resolve(nil, "incoming")
			must(t, err)
			assertThread(resolved)
			for i, ref := range []MessageRef{resolved, minimal} {
				result, err := downstream.Reply(context.Background(), ref, Content{Text: "answer"}, fmt.Sprintf("reply-%d", i))
				must(t, err)
				assertThread(result.Message)
				request := <-requests
				if request.Path != "/open-apis/im/v1/messages/incoming/reply" || request.InThread != (thread != "") {
					t.Errorf("reply request = %+v, want original message with in-thread %v", request, thread != "")
				}
			}
			// A returned reply reference must preserve the same thread for chaining.
			ref, err := downstream.Resolve(nil, "fixture-reply")
			must(t, err)
			_, err = downstream.Reply(context.Background(), ref, Content{Text: "follow-up"}, "follow-up")
			must(t, err)
			request := <-requests
			if request.Path != "/open-apis/im/v1/messages/fixture-reply/reply" || request.InThread != (thread != "") {
				t.Errorf("chained reply request = %+v", request)
			}
		})
	}
}

func TestFeishuAdoptionChecksStyledAnnouncementRoutes(t *testing.T) {
	const own = "agent-session:v1:old-host:codex:existing"
	const other = "agent-session:v1:other-host:codex:other-session"
	styled := func(marker string, docx bool) any {
		parts := []any{}
		for _, part := range []string{marker[:10], marker[10:35], marker[35:]} {
			if docx {
				parts = append(parts, map[string]any{"text_run": map[string]any{"content": part, "text_element_style": map[string]any{"bold": true}}})
			} else {
				parts = append(parts, map[string]any{"type": "textRun", "textRun": map[string]any{"text": part, "style": map[string]any{"bold": true}}})
			}
		}
		return map[string]any{"elements": parts}
	}
	for _, tc := range []struct {
		name     string
		docx     bool
		content  any
		conflict bool
	}{
		{"plain matching", false, own, false},
		{"plain conflict", false, other, true},
		{"no marker", false, "User announcement without routing metadata", false},
		{"empty announcement", false, "", false},
		{"Doc split matching", false, styled(own, false), false},
		{"Doc split conflict", false, styled(other, false), true},
		{"Docx split matching", true, styled(own, true), false},
		{"Docx split conflict", true, styled(other, true), true},
		{"Docx matching and conflicting", true, []any{styled(own, true), styled(other, true)}, true},
		{"separate paragraphs", true, []any{"agent-session:v1:", "other-host:codex:other-session"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			patches := 0
			content := tc.content
			if !tc.docx {
				// Legacy Doc announcements embed their document as a JSON string.
				raw, err := json.Marshal(map[string]any{"blocks": []any{map[string]any{"paragraph": content}}})
				must(t, err)
				content = string(raw)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				var data any
				switch {
				case strings.Contains(r.URL.Path, "tenant_access_token"):
					fmt.Fprint(w, `{"code":0,"tenant_access_token":"announcement-fixture-token","expire":3600}`)
					return
				case r.Method == "GET" && r.URL.Path == "/open-apis/im/v1/chats/group":
					data = map[string]any{"description": "Original description"}
				case r.Method == "GET" && r.URL.Path == "/open-apis/im/v1/chats/group/announcement":
					if tc.docx {
						fmt.Fprint(w, `{"code":232097}`)
						return
					}
					data = map[string]any{"revision": "1", "content": content}
				case r.Method == "GET" && r.URL.Path == "/open-apis/docx/v1/chats/group/announcement":
					data = map[string]any{"revision_id": 1}
				case r.Method == "GET" && r.URL.Path == "/open-apis/docx/v1/chats/group/announcement/blocks":
					data = map[string]any{"items": []any{map[string]any{"block_type": 2, "text": content}}}
				case r.Method == "PATCH" && r.URL.Path == "/open-apis/im/v1/chats/group":
					patches++
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 1 || body["description"] == nil {
						t.Error("adoption must only update the group description")
					}
					data = map[string]any{}
				default:
					t.Errorf("unexpected fixture request: %s %s", r.Method, r.URL.Path)
					http.Error(w, "unexpected request", http.StatusBadRequest)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
			}))
			defer server.Close()
			c := testCore(t, nil)
			cfg := ProviderConfig{ID: "announcement-bot", AppID: "announcement-fixture-app", AppSecret: "fixture-secret", Recipient: "trusted"}
			p := newFeishu(c, cfg)
			defer p.Close()
			p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
			session := Session{NodeID: c.node(), Adapter: "codex", SessionID: "existing", Metadata: map[string]any{"legacy_host": "old-host"}}
			binding, err := p.Bind(context.Background(), session, "group", "")
			if tc.conflict {
				if err == nil || publicError(err).Code != "conflict" || patches != 0 {
					t.Fatalf("conflicting route adopted: error=%v patches=%d", err, patches)
				}
			} else {
				must(t, err)
				if binding.ChatID != "group" || patches != 1 {
					t.Fatalf("legitimate group was not adopted: %+v patches=%d", binding, patches)
				}
			}
		})
	}
}
func TestFeishuDeleteOfficialSDKOnlyAcceptsProvenAbsence(t *testing.T) {
	tests := []struct {
		name         string
		status, code int
		absent       bool
	}{
		{"success", 200, 0, true},
		{"http-not-found", 404, 0, true},
		{"dissolved-http200", 200, 232009, true},
		{"dissolved-documented-http400", 400, 232009, true},
		{"invalid-id-http200", 200, 232006, false},
		{"invalid-id-http400", 400, 232006, false},
		{"application-missing", 200, 232004, false},
		{"not-a-member", 200, 232011, false},
		{"not-an-owner", 200, 232017, false},
		{"not-an-owner-http400", 400, 232017, false},
		{"permission", 403, 99991672, false},
		{"permission-in-not-found-envelope", 404, 99991672, false},
		{"gateway", 502, 0, false},
		{"gateway-with-dissolved-code", 502, 232009, false},
		{"timeout-with-dissolved-code", 408, 232009, false},
		{"rate-limit", 429, 99991400, false},
		{"unknown-application-code", 200, 12345, false},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "tenant_access_token") {
			fmt.Fprint(w, `{"code":0,"tenant_access_token":"delete-fixture-token","expire":3600}`)
			return
		}
		if r.Method == http.MethodDelete {
			for _, tc := range tests {
				if r.URL.Path == "/open-apis/im/v1/chats/"+tc.name {
					w.WriteHeader(tc.status)
					fmt.Fprintf(w, `{"code":%d,"data":{}}`, tc.code)
					return
				}
			}
		}
		t.Errorf("unexpected fixture request: %s %s", r.Method, r.URL.Path)
		http.Error(w, "unexpected request", http.StatusBadRequest)
	}))
	defer server.Close()
	c := testCore(t, nil)
	cfg := ProviderConfig{ID: "delete-bot", AppID: "delete-fixture-app", AppSecret: "fixture-secret"}
	p := newFeishu(c, cfg)
	defer p.Close()
	p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := p.Delete(context.Background(), Binding{ChatID: tc.name})
			if tc.absent {
				must(t, err)
				return
			}
			var rejection *feishuAPIError
			if !errors.As(err, &rejection) || rejection.HTTPStatus != tc.status || rejection.Code != tc.code {
				t.Fatalf("deletion lost its failure: %v; want status %d code %d", err, tc.status, tc.code)
			}
		})
	}
	t.Run("canceled-request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := p.Delete(ctx, Binding{ChatID: "canceled"}); err == nil {
			t.Fatal("canceled deletion was treated as absence")
		}
	})
}

func TestFeishuMissingChatExplicitReactivation(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		name := "already-dissolved"
		if uncertain {
			name = "uncertain-delete-then-dissolved"
		}
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var uuids []string
			deletes := 0
			recovered := !uncertain
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.Contains(r.URL.Path, "tenant_access_token") {
					fmt.Fprint(w, `{"code":0,"tenant_access_token":"reactivation-fixture-token","expire":3600}`)
					return
				}
				mu.Lock()
				defer mu.Unlock()
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/open-apis/im/v1/chats":
					uuids = append(uuids, r.URL.Query().Get("uuid"))
					fmt.Fprintf(w, `{"code":0,"data":{"chat_id":"fixture-group-%d"}}`, len(uuids))
				case r.Method == http.MethodDelete && r.URL.Path == "/open-apis/im/v1/chats/fixture-group-1":
					deletes++
					if !recovered {
						w.WriteHeader(http.StatusBadGateway)
						fmt.Fprint(w, `{"code":99999999}`)
						return
					}
					fmt.Fprint(w, `{"code":232009,"msg":"Your request specifies a chat which has already been dissolved."}`)
				default:
					t.Errorf("unexpected fixture request: %s %s", r.Method, r.URL.Path)
					http.Error(w, "unexpected request", http.StatusBadRequest)
				}
			}))
			defer server.Close()
			c := testCore(t, nil)
			cfg := ProviderConfig{ID: "reactivation-bot", Type: "feishu", AppID: "reactivation-fixture-app", AppSecret: "fixture-secret", Recipient: "trusted"}
			p := newFeishu(c, cfg)
			p.client = lark.NewClient(cfg.AppID, cfg.AppSecret, lark.WithOpenBaseUrl(server.URL), lark.WithLogger(quietLogger{}), lark.WithHttpClient(server.Client()))
			c.providers[cfg.ID] = p
			// Disabled configuration prevents a live WebSocket, including on reopen.
			must(t, c.store.Update(func(d *State) error { d.Providers[cfg.ID] = cfg; d.DefaultProvider = cfg.ID; return nil }))
			session := Session{Adapter: "codex", SessionID: "reactivate", Name: "Retained name", Metadata: map[string]any{"keep": "metadata"}}
			original, err := c.Ensure(context.Background(), "", session)
			must(t, err)
			err = c.Delete(context.Background(), "", session)
			if uncertain == (err == nil) {
				t.Fatalf("delete returned %v, uncertain = %v", err, uncertain)
			}
			deleted := c.store.Snapshot().Bindings[original.Session.key()]
			if !deleted.Deleted || deleted.DeletePending != uncertain {
				t.Fatal("deletion did not retain the correct cleanup state")
			}
			raw, _ := json.Marshal(map[string]any{"session": session, "automatic": true})
			if _, err := c.Handle(context.Background(), "session.ensure", raw, true); publicError(err).Code != "deleted" {
				t.Fatal("automatic ensure reactivated a deleted session")
			}
			if uncertain {
				if _, err := c.Ensure(context.Background(), "", session); err == nil {
					t.Fatal("explicit ensure bypassed uncertain deletion")
				}
				mu.Lock()
				creates := len(uuids)
				recovered = true
				mu.Unlock()
				if creates != 1 || !c.store.Snapshot().Bindings[original.Session.key()].DeletePending {
					t.Fatal("uncertain cleanup created a replacement or lost pending state")
				}
			}
			replacement, err := c.Ensure(context.Background(), "", Session{Adapter: session.Adapter, SessionID: session.SessionID})
			must(t, err)
			retired := c.store.Snapshot().RetiredBindings[resourceKey(original)]
			if replacement.ChatID == original.ChatID || replacement.Deleted || replacement.DeletePending || replacement.Session.Name != session.Name || replacement.Session.Metadata["keep"] != "metadata" || !retired.Deleted || retired.DeletePending {
				t.Fatal("explicit reactivation failed to replace the missing chat and retain its tombstone and metadata")
			}
			mu.Lock()
			defer mu.Unlock()
			wantDeletes := 1
			if uncertain {
				wantDeletes = 3
			}
			if len(uuids) != 2 || uuids[0] == "" || uuids[0] == uuids[1] || deletes != wantDeletes {
				t.Fatalf("replacement reused a create UUID or repeated cleanup: creates = %v, deletes = %d", uuids, deletes)
			}
		})
	}
}

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
