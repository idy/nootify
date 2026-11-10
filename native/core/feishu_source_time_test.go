package main

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestFailedLiveFeishuIngestRecoversWhileConnectionOtherwiseIdle(t *testing.T) {
	for _, mode := range []string{"admission-barrier", "uncertain-submission"} {
		t.Run(mode, func(t *testing.T) {
			var emitted, requests atomic.Int32
			c := testCore(t, func(name string, _ any) error {
				if name == "delivery" {
					emitted.Add(1)
					if mode == "uncertain-submission" {
						return errors.New("synthetic submission outcome unknown")
					}
				}
				return nil
			})
			cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "idle-recovery-" + mode, AppSecret: "synthetic", Recipient: "trusted"}
			created := time.Now().Add(-2 * time.Second).UnixMilli()
			p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				historyPage(w, []map[string]any{historyItem("failed-live", "chat", "trusted", created)}, "")
			})
			s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "idle"}
			must(t, c.store.Update(func(d *State) error {
				d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
				d.FeishuCursors[feishuCursorKey(cfg.AppID, "chat")] = created - 1000
				return nil
			}))
			p.mu.Lock()
			p.connected = true
			p.mu.Unlock()
			if mode == "admission-barrier" {
				var failed atomic.Bool
				c.store.syncDirectory = func(string) error {
					if !failed.Swap(true) {
						return errors.New("synthetic transient directory barrier")
					}
					return nil
				}
			}
			input := feishuInput("failed-live", "chat", "trusted")
			input.Event.Message.CreateTime = str(strconv.FormatInt(created, 10))
			ctx, cancel := context.WithCancel(context.Background())
			if err := p.receive(ctx, input); err == nil {
				t.Fatal("synthetic failed live ingest returned success")
			}
			cancel()
			await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.coverage) == 0 })
			if requests.Load() != 1 || emitted.Load() != 1 {
				t.Fatalf("idle recovery did not execute safe retry exactly once: requests=%d emitted=%d", requests.Load(), emitted.Load())
			}
			for _, v := range c.store.Snapshot().Deliveries {
				if mode == "uncertain-submission" && v.Status != "unconfirmed" {
					t.Fatal("coverage replay changed uncertain submission outcome")
				}
			}
			select {
			case <-time.After(300 * time.Millisecond):
			}
			if requests.Load() != 1 {
				t.Fatal("idle synchronized connection kept polling")
			}
		})
	}
}

func TestFeishuSourceClockPreventsFutureCoverageAndKeepsSameSecondOverlap(t *testing.T) {
	var emitted atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	})
	// The test host clock is ahead of this synthetic Feishu clock. Two messages
	// share one Date-header bucket but have distinct millisecond timestamps.
	source := time.Now().Add(-2 * time.Second).Truncate(time.Second)
	first, second := source.UnixMilli()+100, source.UnixMilli()+600
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "source-skew-app", AppSecret: "synthetic", Recipient: "trusted"}
	var later atomic.Bool
	var requests atomic.Int32
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Date", source.UTC().Format(http.TimeFormat))
		items := []map[string]any{historyItem("first", "chat", "trusted", first)}
		if later.Load() {
			items = append(items, historyItem("second", "chat", "trusted", second))
		}
		historyPage(w, items, "")
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "clock-skew"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = source.UnixMilli() - 1000
		return nil
	}))
	p.mu.Lock()
	p.connected = true
	p.mu.Unlock()
	input := feishuInput("first", "chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(first, 10))
	must(t, p.receive(context.Background(), input))
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.coverage) == 0 })
	if cursor := c.store.Snapshot().FeishuCursors[key]; cursor > first {
		t.Fatalf("host clock advanced coverage into Feishu future: %d > %d", cursor, first)
	}
	// The next source message exists only after the first coverage request has
	// finished, and is missed live during a disconnect.
	later.Store(true)
	p.connectionLost()
	p.connectionReady()
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if emitted.Load() != 2 || requests.Load() != 2 {
		t.Fatalf("reconnect lost same-second source input: emitted=%d requests=%d", emitted.Load(), requests.Load())
	}
	if cursor := c.store.Snapshot().FeishuCursors[key]; cursor > second {
		t.Fatal("reconnect persisted a local-clock future boundary")
	}
}

func TestFeishuEmptyHistoryUsesAPISourceDateInsteadOfFastHostHint(t *testing.T) {
	c := testCore(t, nil)
	source := time.Now().Add(-2 * time.Second).Truncate(time.Second)
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "empty-source-skew-app", AppSecret: "synthetic", Recipient: "trusted"}
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", source.UTC().Format(http.TimeFormat))
		historyPage(w, nil, "")
	})
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "empty-skew"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = source.UnixMilli() - 1000
		return nil
	}))
	must(t, p.reconcileHistory(context.Background(), time.Now().Add(time.Hour).UnixMilli()))
	if cursor := c.store.Snapshot().FeishuCursors[key]; cursor != source.UnixMilli() {
		t.Fatalf("empty scan persisted host hint instead of source Date: %d", cursor)
	}
}
