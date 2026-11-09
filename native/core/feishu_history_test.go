package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func historyItem(id, chat, sender string, created int64) map[string]any {
	return map[string]any{"message_id": id, "chat_id": chat, "create_time": strconv.FormatInt(created, 10), "msg_type": "text", "thread_id": "original-thread", "body": map[string]any{"content": `{"text":"missed input"}`}, "sender": map[string]any{"id": sender, "id_type": "open_id", "sender_type": "user"}}
}

func historyPage(w http.ResponseWriter, items []map[string]any, next string) {
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"items": items, "has_more": next != "", "page_token": next}})
}

func TestFeishuStartupReconciliationPaginatesDeduplicatesAndPreservesOutcomes(t *testing.T) {
	var deliveries, requests atomic.Int32
	delivered := make(chan map[string]any, 4)
	c := testCore(t, func(name string, data any) error {
		if name == "delivery" {
			deliveries.Add(1)
			delivered <- data.(map[string]any)
		}
		return nil
	})
	base := time.Now().Add(-time.Minute).UnixMilli()
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "history-private-app", AppSecret: "synthetic", Recipient: "trusted"}
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/open-apis/im/v1/messages" {
			t.Errorf("unexpected history request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", 400)
			return
		}
		requests.Add(1)
		q := r.URL.Query()
		if q.Get("container_id_type") != "chat" || q.Get("container_id") != "chat" || q.Get("only_thread_root_messages") != "false" || q.Get("start_time") == "" || q.Get("end_time") == "" {
			t.Error("history query did not bound complete chat input")
		}
		if q.Get("page_token") == "" {
			historyPage(w, []map[string]any{historyItem("one", "chat", "trusted", base+1000), historyItem("untrusted", "chat", "other", base+1500)}, "second")
		} else {
			historyPage(w, []map[string]any{historyItem("two", "chat", "trusted", base+2000)}, "")
		}
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "offline"}
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[feishuCursorKey(cfg.AppID, "chat")] = base
		return nil
	}))
	p.connectionReady()
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if deliveries.Load() != 2 || requests.Load() != 2 {
		t.Fatalf("startup catchup = deliveries %d requests %d", deliveries.Load(), requests.Load())
	}
	first, second := <-delivered, <-delivered
	for _, data := range []map[string]any{first, second} {
		ref := data["message"].(MessageRef)
		if ref.ProviderID != cfg.ID || ref.OriginNodeID != c.node() || ref.ThreadID != "original-thread" {
			t.Fatal("history rewrote provider origin or thread context")
		}
	}
	must(t, c.Complete(first["delivery_id"].(string), "unconfirmed", "unknown", ""))
	must(t, c.Complete(second["delivery_id"].(string), "retryable", "offline", ""))
	// A duplicate ready callback while healthy does no work. There is no polling
	// timer: only the next real disconnect/startup boundary starts a new scan.
	p.connectionReady()
	if requests.Load() != 2 {
		t.Fatal("healthy ready callback polled history")
	}
	p.connectionLost()
	// Model a prior crash after ingestion but before the cursor transaction.
	must(t, c.store.Update(func(d *State) error { d.FeishuCursors[feishuCursorKey(cfg.AppID, "chat")] = base; return nil }))
	p.connectionReady()
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if deliveries.Load() != 3 || requests.Load() != 4 || len(c.store.Snapshot().Deliveries) != 2 {
		t.Fatal("reconciliation repeated uncertain input or lost safe retry/deduplication")
	}
	retried := <-delivered
	if retried["delivery_id"] != second["delivery_id"] {
		t.Fatal("history retry changed delivery identity")
	}
}

func TestFeishuFailedCatchupRetriesSameGapWithoutReconnect(t *testing.T) {
	var deliveries atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			deliveries.Add(1)
		}
		return nil
	})
	base := time.Now().Add(-time.Minute).UnixMilli()
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "failed-history-app", AppSecret: "synthetic", Recipient: "trusted"}
	var fail atomic.Bool
	fail.Store(true)
	finished := make(chan struct{}, 16)
	var requests atomic.Int32
	ranges := make(chan [2]string, 64)
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		ranges <- [2]string{r.URL.Query().Get("start_time"), r.URL.Query().Get("end_time")}
		if r.URL.Query().Get("page_token") == "" {
			historyPage(w, []map[string]any{historyItem("before-failure", "chat", "trusted", base+1000)}, "last")
		} else if fail.Load() {
			http.Error(w, "synthetic offline history", 503)
			finished <- struct{}{}
		} else {
			historyPage(w, []map[string]any{historyItem("after-failure", "chat", "trusted", base+2000)}, "")
		}
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "failed-gap"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = base
		return nil
	}))
	p.connectionReady()
	p.mu.Lock()
	generation := p.historyGeneration
	p.mu.Unlock()
	waitRouting(t, finished)
	for id := range c.store.Snapshot().Deliveries {
		must(t, c.Complete(id, "unconfirmed", "unknown", ""))
	}
	must(t, p.receive(context.Background(), feishuInput("live-after-gap", "chat", "trusted")))
	if c.store.Snapshot().FeishuCursors[key] != base {
		t.Fatal("later live input skipped the unresolved history gap")
	}
	fail.Store(false)
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	p.mu.Lock()
	unchanged := p.connected && p.historyGeneration == generation
	p.mu.Unlock()
	if !unchanged || deliveries.Load() != 3 || c.store.Snapshot().FeishuCursors[key] <= base {
		t.Fatal("healthy connection did not recover its failed gap exactly once")
	}
	n := requests.Load()
	firstRange := <-ranges
	for i := int32(1); i < n; i++ {
		if got := <-ranges; got != firstRange {
			t.Fatalf("retry changed the captured history interval: got=%v want=%v", got, firstRange)
		}
	}
	// Successful synchronization ends the retry worker; newer live input must
	// not cause requests after a backoff interval has elapsed.
	must(t, p.receive(context.Background(), feishuInput("live-after-sync", "chat", "trusted")))
	select {
	case extra := <-ranges:
		t.Fatalf("healthy synchronized connection kept polling history: %v", extra)
	case <-time.After(600 * time.Millisecond):
	}
	if requests.Load() != n {
		t.Fatal("history retry continued after success")
	}
}

func TestFeishuHistoryRetryBackoffStopsOnCloseOrGenerationChange(t *testing.T) {
	for _, mode := range []string{"close", "generation"} {
		t.Run(mode, func(t *testing.T) {
			failed := make(chan struct{}, 16)
			c := testCore(t, func(name string, data any) error {
				if name == "log" && data.(map[string]any)["status"] == "feishu_history_reconciliation_failed" {
					failed <- struct{}{}
				}
				return nil
			})
			var requests atomic.Int32
			var success atomic.Bool
			cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "backoff-history-" + mode, AppSecret: "synthetic", Recipient: "trusted"}
			p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if !success.Load() {
					http.Error(w, "synthetic transient failure", 503)
					return
				}
				historyPage(w, nil, "")
			})
			s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "backoff-" + mode}
			base := time.Now().Add(-time.Minute).UnixMilli()
			key := feishuCursorKey(cfg.AppID, "chat")
			must(t, c.store.Update(func(d *State) error {
				d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
				d.FeishuCursors[key] = base
				return nil
			}))
			p.connectionReady()
			waitRouting(t, failed)
			if mode == "close" {
				must(t, p.Close())
			} else {
				p.connectionLost()
				stopped := make(chan struct{})
				go func() { p.historyWG.Wait(); close(stopped) }()
				waitRouting(t, stopped)
			}
			if c.store.Snapshot().FeishuCursors[key] != base {
				t.Fatal("canceled retry advanced an unresolved interval")
			}
			before := requests.Load()
			if mode == "generation" {
				success.Store(true)
				p.connectionReady()
				await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
				if requests.Load() != before+1 {
					t.Fatal("replacement generation duplicated the old recovery worker")
				}
				before++
			} else {
				p.connectionReady()
			}
			select {
			case <-failed:
				t.Fatal("canceled or synchronized recovery continued retrying")
			case <-time.After(600 * time.Millisecond):
			}
			if requests.Load() != before {
				t.Fatal("old recovery generation issued a later history request")
			}
		})
	}
}

func TestFeishuCloseCancelsHistoryBeforeReturning(t *testing.T) {
	c := testCore(t, nil)
	entered := make(chan struct{}, 1)
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "close-history-app", AppSecret: "synthetic", Recipient: "trusted"}
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-r.Context().Done()
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "closing-history"}
	base := time.Now().Add(-time.Minute).UnixMilli()
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = base
		return nil
	}))
	p.connectionReady()
	waitRouting(t, entered)
	done := make(chan error, 1)
	go func() { done <- p.Close() }()
	select {
	case err := <-done:
		must(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("close did not cancel and join history reconciliation")
	}
	if c.store.Snapshot().FeishuCursors[key] != base {
		t.Fatal("close advanced an unprocessed interval")
	}
	if err := p.receive(context.Background(), feishuInput("late", "chat", "trusted")); err == nil {
		t.Fatal("closed provider accepted late input")
	}
}

func TestFeishuFailedLongGapProtectsLiveDedupThroughCompaction(t *testing.T) {
	var deliveries atomic.Int32
	failed := make(chan struct{}, 16)
	var c *Core
	c = testCore(t, func(name string, data any) error {
		if name == "delivery" {
			deliveries.Add(1)
			return c.Complete(data.(map[string]any)["delivery_id"].(string), "delivered", "accepted", "")
		}
		if name == "log" && data.(map[string]any)["status"] == "feishu_history_reconciliation_failed" {
			failed <- struct{}{}
		}
		return nil
	})
	now := time.Now()
	var clock atomic.Int64
	clock.Store(now.UnixNano())
	c.store.clock = func() time.Time { return time.Unix(0, clock.Load()) }
	base := now.Add(-14 * 24 * time.Hour).UnixMilli()
	liveCreated := now.UnixMilli() - 1
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "long-gap-dedup-app", AppSecret: "synthetic", Recipient: "trusted"}
	var fail atomic.Bool
	fail.Store(true)
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "synthetic long history outage", 503)
			return
		}
		historyPage(w, []map[string]any{historyItem("old-missed-input", "chat", "trusted", base+time.Hour.Milliseconds()), historyItem("live-duplicate", "chat", "trusted", liveCreated)}, "")
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "long-gap"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = base
		return nil
	}))
	p.connectionReady()
	waitRouting(t, failed)
	live := feishuInput("live-duplicate", "chat", "trusted")
	live.Event.Message.CreateTime = str(strconv.FormatInt(liveCreated, 10))
	must(t, p.receive(context.Background(), live))
	clock.Store(now.Add(terminalRetention + 24*time.Hour).UnixNano())
	must(t, c.store.Update(func(*State) error { return nil }))
	retained := c.store.Snapshot()
	if len(retained.Events) != 1 || retained.FeishuCursors[key] != base {
		t.Fatal("compaction forgot source dedup or advanced an unresolved long gap")
	}
	for _, event := range retained.Events {
		if event.Event.SourceCreatedAt != liveCreated || !feishuHistoryUnresolved(&retained, event) {
			t.Fatal("live source timestamp was not retained behind the unresolved cursor")
		}
	}
	fail.Store(false)
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if deliveries.Load() != 2 {
		t.Fatal("long-gap retry lost old available input or replayed the terminal live duplicate")
	}
	must(t, p.Close())
	clock.Store(now.Add(2*terminalRetention + 48*time.Hour).UnixNano())
	must(t, c.store.Update(func(*State) error { return nil }))
	if len(c.store.Snapshot().Events) != 0 {
		t.Fatal("successful cursor coverage permanently pinned terminal source history")
	}
}

func TestFeishuHistoryPreservesRemoteOwnershipAcrossLongOutage(t *testing.T) {
	var deliveries atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			deliveries.Add(1)
		}
		return nil
	})
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "ownership-history-app", AppSecret: "synthetic", Recipient: "trusted"}
	end := time.Now().UnixMilli()
	cursor := end - (10 * 24 * time.Hour).Milliseconds()
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		start, _ := strconv.ParseInt(r.URL.Query().Get("start_time"), 10, 64)
		if start != cursor/1000 {
			t.Error("history manufactured a retention cutoff instead of honoring the persisted cursor")
		}
		historyPage(w, []map[string]any{historyItem("older-available-input", "chat", "trusted", end-(9*24*time.Hour).Milliseconds()), historyItem("recent-input", "chat", "trusted", end-1000)}, "")
	})
	s := Session{NodeID: "other-owner", Adapter: "codex", SessionID: "remote-offline"}
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[feishuCursorKey(cfg.AppID, "chat")] = cursor
		return nil
	}))
	peer, err := c.Subscribe(context.Background(), "downstream", "fixture")
	must(t, err)
	defer peer.Close()
	must(t, p.reconcileHistory(context.Background(), end))
	if deliveries.Load() != 0 || len(c.store.Snapshot().Peers["downstream"].Pending) != 2 {
		t.Fatal("long-outage history lost available input or bypassed ownership")
	}
	for _, id := range []string{"older-available-input", "recent-input"} {
		e, err := peer.Next()
		must(t, err)
		if e.Message.MessageID != id || e.Session.key() != s.key() {
			t.Fatalf("history broadcast wrong event: %s", fmt.Sprint(e))
		}
	}
}
