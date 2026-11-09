package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLiveFeishuInputCannotAdvanceCoveragePastOtherUnprocessedChat(t *testing.T) {
	var emitted atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	})
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "coverage-app", AppSecret: "synthetic", Recipient: "trusted"}
	base := time.Now().Add(-time.Minute).UnixMilli()
	entered, release := make(chan struct{}, 1), make(chan struct{})
	var block atomic.Bool
	block.Store(true)
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/open-apis/im/v1/chats/slow" && block.Load() {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		switch {
		case r.URL.Path == "/open-apis/im/v1/messages":
			if r.URL.Query().Get("container_id") == "slow" {
				historyPage(w, []map[string]any{historyItem("slow-input", "slow", "trusted", base+1000)}, "")
			} else {
				historyPage(w, nil, "")
			}
		case strings.HasSuffix(r.URL.Path, "/announcement"):
			fmt.Fprint(w, `{"code":0,"data":{"content":"agent-session:v1:old-host:codex:slow"}}`)
		default:
			fmt.Fprint(w, `{"code":0,"data":{"description":"Human description"}}`)
		}
	})
	p.mu.Lock()
	p.connected = true
	p.mu.Unlock()
	slow := Session{NodeID: c.node(), Adapter: "codex", SessionID: "slow", Metadata: map[string]any{"legacy_host": "old-host"}}
	fast := Session{NodeID: c.node(), Adapter: "codex", SessionID: "fast"}
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[slow.key()] = Binding{ProviderID: cfg.ID, Session: slow, ChatID: "slow", SenderID: "trusted", Legacy: true, LegacyHost: "old-host"}
		d.Bindings[fast.key()] = Binding{ProviderID: cfg.ID, Session: fast, ChatID: "fast", SenderID: "trusted"}
		d.FeishuCursors[feishuCursorKey(cfg.AppID, "slow")] = base
		d.FeishuCursors[feishuCursorKey(cfg.AppID, "fast")] = base
		return nil
	}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := feishuInput("slow-input", "slow", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(base+1000, 10))
	done := make(chan error, 1)
	go func() { done <- p.receive(ctx, input) }()
	waitRouting(t, entered)
	must(t, p.receive(context.Background(), feishuInput("fast-input", "fast", "trusted")))
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.coverage) == 0 })
	if c.store.Snapshot().FeishuCursors[feishuCursorKey(cfg.AppID, "slow")] != base {
		t.Fatal("another chat's proven scan skipped unprocessed input")
	}
	if c.store.Snapshot().FeishuCursors[feishuCursorKey(cfg.AppID, "fast")] <= base {
		t.Fatal("event-triggered finite scan did not prove healthy chat coverage")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("synthetic slow validation was not interrupted")
	}
	block.Store(false)
	close(release)
	p.connectionLost()
	p.connectionReady()
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if emitted.Load() != 2 {
		t.Fatal("reconnect skipped previously unprocessed old input")
	}
}

func TestHealthyLiveCoverageAllowsCompletedSourceHistoryCompaction(t *testing.T) {
	var c *Core
	c = testCore(t, func(name string, data any) error {
		if name == "delivery" {
			return c.Complete(data.(map[string]any)["delivery_id"].(string), "delivered", "accepted", "")
		}
		return nil
	})
	now := time.Now()
	var clock atomic.Int64
	clock.Store(now.UnixNano())
	c.store.clock = func() time.Time { return time.Unix(0, clock.Load()) }
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "healthy-coverage-app", AppSecret: "synthetic", Recipient: "trusted"}
	created := now.UnixMilli()
	var requests atomic.Int32
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		historyPage(w, []map[string]any{historyItem("live", "chat", "trusted", created)}, "")
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "healthy-long"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = created - 1000
		return nil
	}))
	p.mu.Lock()
	p.connected = true
	p.mu.Unlock()
	input := feishuInput("live", "chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(created, 10))
	must(t, p.receive(context.Background(), input))
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.coverage) == 0 })
	if c.store.Snapshot().FeishuCursors[key] < created || requests.Load() != 1 {
		t.Fatal("live-triggered finite scan did not prove source coverage")
	}
	clock.Store(now.Add(terminalRetention + time.Hour).UnixNano())
	must(t, c.store.Update(func(*State) error { return nil }))
	if len(c.store.Snapshot().Events) != 0 || len(c.store.Snapshot().Deliveries) != 0 {
		t.Fatal("healthy synchronized source completed traffic remained pinned")
	}
	select {
	case <-time.After(300 * time.Millisecond):
	}
	if requests.Load() != 1 {
		t.Fatal("healthy idle connection polled history")
	}
}

func TestLiveCoverageCannotPassFailedEarlierHistoryPage(t *testing.T) {
	var count atomic.Int32
	var c *Core
	c = testCore(t, func(name string, data any) error {
		if name == "delivery" {
			count.Add(1)
			return c.Complete(data.(map[string]any)["delivery_id"].(string), "delivered", "accepted", "")
		}
		return nil
	})
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "blocked-coverage-app", AppSecret: "synthetic", Recipient: "trusted"}
	base := time.Now().Add(-time.Minute).UnixMilli()
	var fail atomic.Bool
	fail.Store(true)
	failed := make(chan struct{}, 16)
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "earlier page unavailable", 503)
			failed <- struct{}{}
			return
		}
		historyPage(w, []map[string]any{historyItem("earlier", "chat", "trusted", base+1000), historyItem("later", "chat", "trusted", base+2000)}, "")
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "blocked-coverage"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = base
		return nil
	}))
	p.mu.Lock()
	p.connected = true
	p.mu.Unlock()
	input := feishuInput("later", "chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(base+2000, 10))
	must(t, p.receive(context.Background(), input))
	waitRouting(t, failed)
	if c.store.Snapshot().FeishuCursors[key] != base {
		t.Fatal("live input skipped a failed earlier coverage interval")
	}
	fail.Store(false)
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.coverage) == 0 })
	if count.Load() != 2 || c.store.Snapshot().FeishuCursors[key] <= base {
		t.Fatal("proven retry did not recover earlier history without repeating later input")
	}
}

func TestFeishuPublicationReconcilesInvitationBeforeCreateReturns(t *testing.T) {
	var emitted atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	})
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "invitation-gap-app", AppSecret: "synthetic", Recipient: "trusted"}
	invited, release := make(chan struct{}, 1), make(chan struct{})
	var created atomic.Int64
	var history atomic.Int32
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/open-apis/im/v1/chats" {
			created.Store(time.Now().UnixMilli())
			invited <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, `{"code":0,"data":{"chat_id":"invited-chat"}}`)
			return
		}
		if r.URL.Path == "/open-apis/im/v1/messages" {
			history.Add(1)
			start, _ := strconv.ParseInt(r.URL.Query().Get("start_time"), 10, 64)
			if start > created.Load()/1000 {
				t.Error("publication cursor skipped the pre-response invitation interval")
			}
			historyPage(w, []map[string]any{historyItem("invitation-input", "invited-chat", "trusted", created.Load())}, "")
			return
		}
		t.Errorf("unexpected fixture: %s %s", r.Method, r.URL.Path)
		http.Error(w, "unexpected", 400)
	})
	p.mu.Lock()
	p.connected = true
	p.mu.Unlock()
	s := Session{Adapter: "codex", SessionID: "created"}
	done := make(chan error, 1)
	go func() { _, err := c.Ensure(context.Background(), "bot", s); done <- err }()
	waitRouting(t, invited)
	input := feishuInput("invitation-input", "invited-chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(created.Load(), 10))
	must(t, p.receive(context.Background(), input))
	if emitted.Load() != 0 {
		t.Fatal("unpublished group routed input")
	}
	close(release)
	must(t, <-done)
	await(t, func() bool { return emitted.Load() == 1 })
	must(t, p.receive(context.Background(), input))
	if emitted.Load() != 1 || history.Load() != 1 {
		t.Fatal("new publication did not reconcile invitation gap exactly once")
	}
	b := c.store.Snapshot().Bindings[c.normalize(s).key()]
	if b.HistoryStart == 0 || b.HistoryStart >= created.Load() {
		raw, _ := json.Marshal(b)
		t.Fatalf("precreate coverage boundary missing: %s", raw)
	}
}
