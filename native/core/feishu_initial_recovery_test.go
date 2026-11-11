package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMissingFeishuCursorScansFailedLiveAdmissionBeforeCompleting(t *testing.T) {
	for _, failure := range []string{"committed-barrier", "precommit", "uncertain"} {
		t.Run(failure, func(t *testing.T) {
			var emitted, history atomic.Int32
			c := testCore(t, func(name string, _ any) error {
				if name == "delivery" {
					emitted.Add(1)
					if failure == "uncertain" {
						return errors.New("synthetic unknown submission outcome")
					}
				}
				return nil
			})
			cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "initial-recovery-" + failure, AppSecret: "synthetic", Recipient: "trusted"}
			source := time.Now().UTC().Truncate(time.Second)
			created := source.Add(-5 * time.Second).UnixMilli()
			probe, release := make(chan struct{}, 1), make(chan struct{})
			p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Date", source.Format(http.TimeFormat))
				if r.URL.Path == "/open-apis/im/v1/chats/chat" {
					probe <- struct{}{}
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
					fmt.Fprint(w, `{"code":0,"data":{"description":"existing group"}}`)
					return
				}
				if r.URL.Path == "/open-apis/im/v1/messages" {
					n := history.Add(1)
					start, _ := strconv.ParseInt(r.URL.Query().Get("start_time"), 10, 64)
					if n == 1 && start > created/1000 {
						t.Errorf("initial checkpoint skipped failed live input: start=%d create=%d", start, created/1000)
					}
					historyPage(w, []map[string]any{historyItem("failed-during-initialization", "chat", "trusted", created)}, "")
					return
				}
				t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				http.Error(w, "unexpected", 400)
			})
			s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "initializing"}
			must(t, c.store.Update(func(d *State) error {
				d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
				return nil
			}))
			p.connectionReady()
			waitRouting(t, probe)
			originalDir := c.store.dir
			if failure == "committed-barrier" {
				var failed atomic.Bool
				c.store.syncDirectory = func(string) error {
					if !failed.Swap(true) {
						return errors.New("synthetic admission barrier")
					}
					return nil
				}
			} else if failure == "precommit" {
				c.store.mu.Lock()
				c.store.dir = filepath.Join(t.TempDir(), "missing-parent")
				c.store.mu.Unlock()
			}
			input := feishuInput("failed-during-initialization", "chat", "trusted")
			input.Event.Message.CreateTime = str(strconv.FormatInt(created, 10))
			ctx, cancel := context.WithCancel(context.Background())
			err := p.receive(ctx, input)
			cancel()
			if failure == "precommit" {
				c.store.mu.Lock()
				c.store.dir = originalDir
				c.store.mu.Unlock()
			}
			if err == nil {
				t.Fatal("synthetic admission did not fail")
			}
			if failure != "uncertain" && emitted.Load() != 0 {
				t.Fatal("failed admission submitted an agent command")
			}
			close(release)
			await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering && len(p.coverage) == 0 })
			if emitted.Load() != 1 || history.Load() == 0 {
				t.Fatalf("initial reconciliation completed without recovering failed input: emitted=%d history=%d", emitted.Load(), history.Load())
			}
			if failure == "uncertain" {
				for _, delivery := range c.store.Snapshot().Deliveries {
					if delivery.Status != "unconfirmed" {
						t.Fatal("initial recovery forgot genuine submission uncertainty")
					}
				}
			}
			before := history.Load()
			select {
			case <-time.After(350 * time.Millisecond):
			}
			if history.Load() != before {
				t.Fatal("completed initial recovery kept polling the idle chat")
			}
		})
	}
}

func TestInitialCursorCommitPreservesLaterFailedObservationAcrossRestart(t *testing.T) {
	var emitted atomic.Int32
	emit := func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	}
	c := testCore(t, emit)
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "initial-recovery-commit-race", AppSecret: "synthetic", Recipient: "trusted"}
	source := time.Now().UTC().Truncate(time.Second)
	created := source.Add(-5 * time.Second).UnixMilli()
	var replay atomic.Bool
	historyEntered, historyRelease := make(chan struct{}, 1), make(chan struct{})
	var finalPhase atomic.Bool
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", source.Format(http.TimeFormat))
		if r.URL.Path == "/open-apis/im/v1/chats/chat" {
			fmt.Fprint(w, `{"code":0,"data":{"description":"existing group"}}`)
			return
		}
		if r.URL.Path == "/open-apis/im/v1/messages" {
			if !replay.Load() {
				finalPhase.Store(true)
				historyEntered <- struct{}{}
				select {
				case <-historyRelease:
				case <-r.Context().Done():
					return
				}
				historyPage(w, nil, "")
			} else {
				historyPage(w, []map[string]any{historyItem("late-failed-input", "chat", "trusted", created)}, "")
			}
			return
		}
		t.Errorf("unexpected request %s", r.URL.Path)
		http.Error(w, "unexpected", 400)
	}
	p := privateFeishu(t, c, cfg, handler)
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "initial-commit-race"}
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		return nil
	}))
	checkpoint, checkpointRelease := make(chan struct{}, 1), make(chan struct{})
	var held atomic.Bool
	originalSync := c.store.syncDirectory
	c.store.syncDirectory = func(path string) error {
		if finalPhase.Load() && !held.Swap(true) {
			checkpoint <- struct{}{}
			<-checkpointRelease
		}
		return originalSync(path)
	}
	p.connectionReady()
	waitRouting(t, historyEntered)
	// The scan already captured its recovery bound and first page. This older
	// live callback is known only after that capture, and leaves no Store record.
	originalDir := c.store.dir
	c.store.mu.Lock()
	c.store.dir = filepath.Join(t.TempDir(), "missing-parent")
	c.store.mu.Unlock()
	input := feishuInput("late-failed-input", "chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(created, 10))
	err := p.receive(context.Background(), input)
	c.store.mu.Lock()
	c.store.dir = originalDir
	c.store.mu.Unlock()
	if err == nil {
		t.Fatal("synthetic live admission did not fail")
	}
	close(historyRelease)
	waitRouting(t, checkpoint)
	// Stop before the coalesced follow-up can use its in-memory lower bound.
	p.cancel()
	close(checkpointRelease)
	must(t, p.Close())
	if emitted.Load() != 0 {
		t.Fatal("the incomplete initial scan submitted input")
	}
	c = reopenCore(t, c, emit)
	replay.Store(true)
	p = privateFeishu(t, c, cfg, handler)
	p.connectionReady()
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if emitted.Load() != 1 {
		t.Fatal("cursor publication lost the only recovery bound across process restart")
	}
}

func TestInitialSeedPersistsObservationBeforeFailedAdmissionAndRestart(t *testing.T) {
	var emitted atomic.Int32
	emit := func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	}
	c := testCore(t, emit)
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "initial-recovery-early-crash", AppSecret: "synthetic", Recipient: "trusted"}
	source := time.Now().UTC().Truncate(time.Second)
	created := source.Add(-5 * time.Second).UnixMilli()
	var replay atomic.Bool
	entered := make(chan struct{}, 1)
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", source.Format(http.TimeFormat))
		if r.URL.Path == "/open-apis/im/v1/chats/chat" {
			fmt.Fprint(w, `{"code":0,"data":{"description":"existing group"}}`)
			return
		}
		if r.URL.Path == "/open-apis/im/v1/messages" {
			if !replay.Load() {
				entered <- struct{}{}
				<-r.Context().Done()
				return
			}
			historyPage(w, []map[string]any{historyItem("precommit-refused", "chat", "trusted", created)}, "")
			return
		}
		t.Errorf("unexpected request %s", r.URL.Path)
		http.Error(w, "unexpected", 400)
	}
	p := privateFeishu(t, c, cfg, handler)
	p.receiver = func(context.Context, Event) error {
		return fault("unavailable", "synthetic refusal before Store admission")
	}
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "initial-early-crash"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		return nil
	}))
	p.connectionReady()
	waitRouting(t, entered)
	input := feishuInput("precommit-refused", "chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(created, 10))
	if err := p.receive(context.Background(), input); err == nil {
		t.Fatal("synthetic admission refusal did not fail")
	}
	if len(c.store.Snapshot().Events) != 0 || c.store.Snapshot().FeishuCursors[key] > created {
		t.Fatal("initial seed lost a source observation before admission failed")
	}
	must(t, p.Close()) // Stop while the original scan still has no completed page.
	c = reopenCore(t, c, emit)
	replay.Store(true)
	p = privateFeishu(t, c, cfg, handler)
	p.connectionReady()
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if emitted.Load() != 1 {
		t.Fatal("restart before final coverage commit lost the durably observed lower bound")
	}
}

func TestEstablishedCursorDoesNotRescanMuchOlderLiveObservation(t *testing.T) {
	c := testCore(t, nil)
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "established-cursor-monotonic", AppSecret: "synthetic", Recipient: "trusted"}
	source := time.Now().UTC().Truncate(time.Second)
	cursor := source.Add(-time.Second).UnixMilli()
	var requests atomic.Int32
	p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Date", source.Format(http.TimeFormat))
		start, _ := strconv.ParseInt(r.URL.Query().Get("start_time"), 10, 64)
		if r.URL.Path != "/open-apis/im/v1/messages" || start != (cursor-sourceTimeOverlap)/1000 {
			t.Error("established cursor rescanned older already-covered history")
		}
		historyPage(w, nil, "")
	})
	p.receiver = func(context.Context, Event) error { return fault("unavailable", "synthetic failed delayed duplicate") }
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "established"}
	key := feishuCursorKey(cfg.AppID, "chat")
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		d.FeishuCursors[key] = cursor
		return nil
	}))
	input := feishuInput("old-observation", "chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(source.Add(-10*24*time.Hour).UnixMilli(), 10))
	if err := p.receive(context.Background(), input); err == nil {
		t.Fatal("synthetic delayed observation did not fail")
	}
	must(t, p.reconcileHistory(context.Background(), source.UnixMilli()))
	if requests.Load() != 1 || c.store.Snapshot().FeishuCursors[key] < cursor {
		t.Fatal("established cursor rewound for an older observation")
	}
}

func TestMissingFeishuCursorRecoversRetryableAdmissionAfterRestart(t *testing.T) {
	var emitted atomic.Int32
	emit := func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	}
	c := testCore(t, emit)
	cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "initial-recovery-restart", AppSecret: "synthetic", Recipient: "trusted"}
	source := time.Now().UTC().Truncate(time.Second)
	created := source.Add(-10 * time.Second).UnixMilli()
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", source.Format(http.TimeFormat))
		if r.URL.Path == "/open-apis/im/v1/chats/chat" {
			fmt.Fprint(w, `{"code":0,"data":{"description":"existing group"}}`)
			return
		}
		if r.URL.Path == "/open-apis/im/v1/messages" {
			start, _ := strconv.ParseInt(r.URL.Query().Get("start_time"), 10, 64)
			if start > created/1000 {
				t.Error("initial seed skipped retained retryable source input")
			}
			historyPage(w, []map[string]any{historyItem("retained-retryable", "chat", "trusted", created)}, "")
			return
		}
		t.Errorf("unexpected request %s", r.URL.Path)
		http.Error(w, "unexpected", 400)
	}
	p := privateFeishu(t, c, cfg, handler)
	s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "initial-restart"}
	must(t, c.store.Update(func(d *State) error {
		d.Bindings[s.key()] = Binding{ProviderID: cfg.ID, Session: s, ChatID: "chat", SenderID: "trusted"}
		return nil
	}))
	var failed atomic.Bool
	c.store.syncDirectory = func(string) error {
		if !failed.Swap(true) {
			return errors.New("synthetic admission barrier")
		}
		return nil
	}
	input := feishuInput("retained-retryable", "chat", "trusted")
	input.Event.Message.CreateTime = str(strconv.FormatInt(created, 10))
	if err := p.receive(context.Background(), input); err == nil {
		t.Fatal("synthetic admission did not fail")
	}
	if emitted.Load() != 0 {
		t.Fatal("failed admission submitted before restart")
	}
	c = reopenCore(t, c, emit)
	p = privateFeishu(t, c, cfg, handler)
	p.connectionReady()
	await(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return !p.recovering })
	if emitted.Load() != 1 {
		t.Fatal("restart without an in-memory lower bound stranded a retained retryable admission")
	}
}

func TestFeishuAdoptionRequiresFreshSourceTimeEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, date string
		cached     bool
		valid      bool
	}{
		{name: "absent"},
		{name: "malformed", date: "not-a-date"},
		{name: "absent-with-cached-clock", cached: true},
		{name: "malformed-with-cached-clock", date: "not-a-date", cached: true},
		{name: "fresh", date: time.Now().UTC().Format(http.TimeFormat), valid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testCore(t, nil)
			cfg := ProviderConfig{ID: "bot", Type: "feishu", AppID: "adoption-source-" + tc.name, AppSecret: "synthetic", Recipient: "trusted"}
			var history, writes atomic.Int32
			p := privateFeishu(t, c, cfg, func(w http.ResponseWriter, r *http.Request) {
				if tc.date == "" {
					w.Header()["Date"] = nil
				} else {
					w.Header().Set("Date", tc.date)
				}
				if r.Method != "GET" {
					writes.Add(1)
				}
				switch {
				case strings.HasSuffix(r.URL.Path, "/announcement"):
					fmt.Fprint(w, `{"code":0,"data":{"content":"Preserved human announcement"}}`)
				case r.URL.Path == "/open-apis/im/v1/chats/chat":
					fmt.Fprint(w, `{"code":0,"data":{"description":"Preserved human description"}}`)
				case r.URL.Path == "/open-apis/im/v1/messages":
					history.Add(1)
					historyPage(w, []map[string]any{historyItem("old-command", "chat", "trusted", time.Now().Add(-24*time.Hour).UnixMilli())}, "")
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					http.Error(w, "unexpected", 400)
				}
			})
			if tc.cached {
				p.mu.Lock()
				p.sourceFloor = time.Now().Add(-24 * time.Hour).UnixMilli()
				p.mu.Unlock()
			}
			s := Session{Adapter: "codex", SessionID: "adoption"}
			b, err := c.Bind(context.Background(), "bot", s, "chat", "trusted")
			if tc.valid {
				must(t, err)
				source, parseErr := http.ParseTime(tc.date)
				must(t, parseErr)
				if b.HistoryStart != source.UnixMilli()-sourceTimeOverlap {
					t.Fatalf("fresh source boundary not preserved: %d", b.HistoryStart)
				}
			} else {
				if err == nil || publicError(err).Code != "unavailable" {
					t.Fatalf("adoption accepted missing fresh source time: binding=%+v err=%v", b, err)
				}
				if len(c.store.Snapshot().Bindings) != 0 || len(c.store.Snapshot().FeishuCursors) != 0 {
					t.Fatal("failed adoption persisted an epoch cursor or binding")
				}
			}
			if history.Load() != 0 || writes.Load() != 0 {
				t.Fatal("adoption replayed old history or mutated human content")
			}
		})
	}
}
