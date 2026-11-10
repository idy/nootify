package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func retentionStore(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	must(t, err)
	at := time.Now().UTC()
	store.clock = func() time.Time { return at }
	t.Cleanup(func() { _ = store.Close() })
	return store, &at
}

func retentionEvent(id string, sequence uint64, outcome string) EventRecord {
	return EventRecord{Sequence: sequence, Outcome: outcome, Event: Event{
		ID: id, Session: Session{NodeID: "origin", Adapter: "synthetic", SessionID: "session"},
		Message: MessageRef{OriginNodeID: "origin", ProviderID: "synthetic", MessageID: id, ThreadID: "return-thread"},
		Content: Content{Text: "private synthetic fixture"}, Hops: 4,
	}}
}

func TestStoreRetentionTerminalHorizonsSurviveRestart(t *testing.T) {
	s, at := retentionStore(t)
	initial := *at
	event := retentionEvent("completed", 0, "local")
	must(t, s.Update(func(d *State) error {
		d.Events[event.Event.ID] = event
		d.Deliveries["receipt"] = Delivery{ID: "receipt", EventID: event.Event.ID, Status: "delivered"}
		result, err := json.Marshal(SendResult{Message: event.Event.Message, MessageID: event.Event.Message.MessageID})
		if err != nil {
			return err
		}
		d.Operations["completed-send"] = Operation{State: "complete", Result: result}
		d.Operations["rejected-send"] = Operation{State: "terminal"}
		remember(d, event.Event.Message, "return-provider")
		d.Bindings["binding"] = Binding{ProviderID: "synthetic"}
		d.RetiredBindings["retired"] = Binding{Deleted: true}
		d.ProviderTombstones["removed"] = true
		d.FeishuCursors["synthetic-cursor"] = initial.UnixMilli()
		return nil
	}))
	*at = initial.Add(terminalRetention - time.Nanosecond)
	must(t, s.Update(func(*State) error { return nil }))
	before := s.Snapshot()
	if len(before.Events) != 1 || len(before.Deliveries) != 1 || len(before.Operations) != 2 {
		t.Fatal("terminal dedup horizon shortened")
	}
	must(t, s.Close())
	reopened, err := OpenStore(s.dir)
	must(t, err)
	t.Cleanup(func() { _ = reopened.Close() })
	reopened.clock = s.clock
	*at = initial.Add(terminalRetention)
	must(t, reopened.Update(func(*State) error { return nil }))
	d := reopened.Snapshot()
	if len(d.Events) != 0 || len(d.Deliveries) != 0 || len(d.Operations) != 0 {
		t.Fatal("completed ledgers did not reclaim at their persisted horizon")
	}
	if len(d.References) != 1 {
		t.Fatal("return path expired before its separate horizon")
	}
	if len(d.Bindings) != 1 || len(d.RetiredBindings) != 1 || !d.ProviderTombstones["removed"] || d.FeishuCursors["synthetic-cursor"] != initial.UnixMilli() {
		t.Fatal("retention altered routing, deletion protection, or history cursors")
	}
	*at = initial.Add(referenceRetention)
	must(t, reopened.Update(func(*State) error { return nil }))
	d = reopened.Snapshot()
	if len(d.References) != 0 || len(d.Retention.Events) != 0 || len(d.Retention.Deliveries) != 0 || len(d.Retention.Operations) != 0 || len(d.Retention.References) != 0 {
		t.Fatal("expired return paths or orphan retention metadata remained")
	}
}

func TestStoreRetentionProtectsIndependentPeerBacklogsAndUncertainWork(t *testing.T) {
	s, at := retentionStore(t)
	initial := *at
	var originalReply MessageRef
	must(t, s.Update(func(d *State) error {
		for i, id := range []string{"window", "backlog"} {
			e := retentionEvent(id, uint64(i+1), "broadcast")
			d.Events[id] = e
			remember(d, e.Event.Message, "route")
		}
		d.BroadcastSequence = 2
		d.Peers["slow"] = Peer{NodeID: "slow", Pending: []string{"window"}, Cursor: 1, PublicKey: "synthetic-key"}
		d.Peers["fast"] = Peer{NodeID: "fast", Cursor: 2, PublicKey: "another-synthetic-key"}
		for _, status := range []string{"pending", "unconfirmed", "retryable", "unknown-future-status", "delivered", "rejected"} {
			e := retentionEvent(status, 0, "local")
			d.Events[status] = e
			d.Deliveries[status] = Delivery{ID: status, EventID: status, Status: status}
			remember(d, e.Event.Message, "route")
		}
		for _, state := range []string{"pending", "unconfirmed", "retryable", "unknown-future-state"} {
			d.Operations[state] = Operation{State: state, Fingerprint: state}
		}
		originalReply = MessageRef{OriginNodeID: "remote", ProviderID: "upstream", MessageID: "reply-target", ThreadID: "thread"}
		remember(d, originalReply, "return-route")
		d.Operations["reply:"+originalReply.key()+":opaque:request"] = Operation{State: "unconfirmed"}
		remember(d, MessageRef{OriginNodeID: "remote", ProviderID: "upstream", MessageID: "unrelated"}, "route")
		return nil
	}))
	*at = initial.Add(90 * 24 * time.Hour)
	must(t, s.Update(func(*State) error { return nil }))
	d := s.Snapshot()
	for _, id := range []string{"window", "backlog", "pending", "unconfirmed", "retryable", "unknown-future-status"} {
		if _, exists := d.Events[id]; !exists {
			t.Fatalf("lost protected event %s", id)
		}
		if _, exists := d.References[d.Events[id].Event.Message.key()]; !exists {
			t.Fatalf("lost protected return path %s", id)
		}
	}
	if len(d.Deliveries) != 4 || len(d.Operations) != 5 || len(d.Events) != 6 || len(d.References) != 7 {
		t.Fatalf("unexpected protected/reclaimed ledger sizes: events=%d deliveries=%d operations=%d references=%d", len(d.Events), len(d.Deliveries), len(d.Operations), len(d.References))
	}
	if d.References[originalReply.key()].Message.ThreadID != "thread" {
		t.Fatal("uncertain reply lost its original return context")
	}
	if len(d.Peers["fast"].Pending) != 0 || d.Peers["fast"].Cursor != 2 || d.Peers["slow"].Cursor != 1 || d.Peers["slow"].PublicKey != "synthetic-key" {
		t.Fatal("retention changed independent peer progress or an identity pin")
	}
	must(t, s.Update(func(d *State) error {
		peer := d.Peers["slow"]
		peer.Pending = nil
		d.Peers["slow"] = refillPeer(peer, broadcastLog(d))
		return nil
	}))
	*at = at.Add(terminalRetention)
	must(t, s.Update(func(*State) error { return nil }))
	d = s.Snapshot()
	if _, exists := d.Events["window"]; exists {
		t.Fatal("confirmed peer window was never reclaimed")
	}
	if _, exists := d.Events["backlog"]; !exists || len(d.Peers["slow"].Pending) != 1 || d.Peers["slow"].Pending[0] != "backlog" {
		t.Fatal("refilled backlog did not remain independently protected")
	}
}

func TestStoreRetentionQueuedInboxSurvivesUntilConsumed(t *testing.T) {
	for _, adapter := range []string{"trae", "workbuddy"} {
		t.Run(adapter, func(t *testing.T) {
			s, at := retentionStore(t)
			initial := *at
			event := retentionEvent("queued", 0, "local")
			event.Event.Session.Adapter = adapter
			must(t, s.Update(func(d *State) error {
				d.Events["queued"] = event
				d.Deliveries["queued"] = Delivery{ID: "queued", EventID: "queued", Status: "delivered", Transport: "inbox_queued"}
				remember(d, event.Event.Message, "remote-return-route")
				return nil
			}))
			*at = initial.Add(90 * 24 * time.Hour)
			must(t, s.Update(func(*State) error { return nil }))
			d := s.Snapshot()
			if len(d.Events) != 1 || len(d.Deliveries) != 1 || len(d.References) != 1 || d.References[event.Event.Message.key()].Message.ThreadID != "return-thread" {
				t.Fatal("unconsumed inbox lost its source event or structured return path")
			}
			consumed := *at
			must(t, s.Update(func(d *State) error {
				v := d.Deliveries["queued"]
				v.Transport = "inbox_consumed"
				d.Deliveries["queued"] = v
				return nil
			}))
			*at = consumed.Add(terminalRetention - time.Nanosecond)
			must(t, s.Update(func(*State) error { return nil }))
			if d := s.Snapshot(); len(d.Events) != 1 || len(d.Deliveries) != 1 {
				t.Fatal("consumption shortened terminal dedup horizon")
			}
			*at = consumed.Add(terminalRetention)
			must(t, s.Update(func(*State) error { return nil }))
			if d := s.Snapshot(); len(d.Events) != 0 || len(d.Deliveries) != 0 || len(d.References) != 0 {
				t.Fatal("consumed inbox permanently pinned completed history")
			}
		})
	}
}

func TestStoreRetentionStartsNewHorizonAtCompletionAndReferenceTouch(t *testing.T) {
	s, at := retentionStore(t)
	initial := *at
	event := retentionEvent("pending", 0, "local")
	must(t, s.Update(func(d *State) error {
		d.Events[event.Event.ID] = event
		d.Deliveries["pending"] = Delivery{ID: "pending", EventID: "pending", Status: "pending"}
		d.Operations["pending"] = Operation{State: "pending"}
		remember(d, event.Event.Message, "route")
		return nil
	}))
	*at = initial.Add(60 * 24 * time.Hour)
	completed := *at
	must(t, s.Update(func(d *State) error {
		delivery := d.Deliveries["pending"]
		delivery.Status = "delivered"
		d.Deliveries["pending"] = delivery
		d.Operations["pending"] = Operation{State: "complete"}
		remember(d, event.Event.Message, "route") // Identical data must refresh age.
		return nil
	}))
	*at = completed.Add(terminalRetention - time.Nanosecond)
	must(t, s.Update(func(*State) error { return nil }))
	if d := s.Snapshot(); len(d.Deliveries) != 1 || len(d.Events) != 1 || len(d.Operations) != 1 {
		t.Fatal("completion did not start a full dedup horizon")
	}
	*at = completed.Add(terminalRetention)
	must(t, s.Update(func(*State) error { return nil }))
	if d := s.Snapshot(); len(d.Events) != 0 || len(d.Deliveries) != 0 || len(d.Operations) != 0 || len(d.References) != 1 {
		t.Fatal("terminal retention or identical reference touch was incorrect")
	}
	*at = completed.Add(referenceRetention - time.Nanosecond)
	must(t, s.Update(func(*State) error { return nil }))
	if len(s.Snapshot().References) != 1 {
		t.Fatal("touched reference lost its full horizon")
	}
	*at = completed.Add(referenceRetention)
	must(t, s.Update(func(*State) error { return nil }))
	if len(s.Snapshot().References) != 0 {
		t.Fatal("touched reference never expired")
	}
}

func TestStoreRetentionReclaimsFullCompletedLedgerButRefusesProtectedOverflow(t *testing.T) {
	for _, state := range []string{"complete", "unconfirmed"} {
		t.Run(state, func(t *testing.T) {
			s, at := retentionStore(t)
			must(t, s.Update(func(d *State) error {
				for i := 0; i < maxRecords; i++ {
					d.Operations[fmt.Sprintf("request-%05d", i)] = Operation{State: state, Fingerprint: "synthetic"}
				}
				return nil
			}))
			*at = at.Add(terminalRetention)
			err := s.Update(func(d *State) error {
				d.Operations["new-request"] = Operation{State: "pending", Fingerprint: "new"}
				return nil
			})
			d := s.Snapshot()
			if state == "complete" {
				must(t, err)
				if len(d.Operations) != 1 || d.Operations["new-request"].State != "pending" {
					t.Fatal("completed ledger did not make room for new admissions")
				}
			} else if err == nil || publicError(err).Code != "resource_exhausted" || len(d.Operations) != maxRecords {
				t.Fatalf("protected ledger overflow was not rejected atomically: %v", err)
			}
		})
	}
}

func TestStoreRetentionMigratesMissingAgesAndReclaimsPayloads(t *testing.T) {
	s, _ := retentionStore(t)
	event := retentionEvent("legacy", 0, "deleted")
	event.Event.Content.Text = strings.Repeat("x", 1<<20)
	must(t, s.Update(func(d *State) error { d.Events["legacy"] = event; return nil }))
	// Model an on-disk pre-retention state with no record timestamps.
	d := s.Snapshot()
	d.Retention = LedgerRetention{}
	legacy, err := json.Marshal(d)
	must(t, err)
	must(t, os.WriteFile(filepath.Join(s.dir, "state.json"), legacy, 0600))
	must(t, s.Close())
	reopened, err := OpenStore(s.dir)
	must(t, err)
	t.Cleanup(func() { _ = reopened.Close() })
	migrationAge := reopened.Snapshot().Retention.Events["legacy"]
	if migrationAge == 0 || len(reopened.Snapshot().Events) != 1 {
		t.Fatal("legacy records did not receive a full retention grace period")
	}
	reopened.clock = func() time.Time { return time.Unix(0, migrationAge).Add(terminalRetention - time.Nanosecond) }
	must(t, reopened.Update(func(*State) error { return nil }))
	if len(reopened.Snapshot().Events) != 1 {
		t.Fatal("legacy payload reclaimed early")
	}
	reopened.clock = func() time.Time { return time.Unix(0, migrationAge).Add(terminalRetention) }
	must(t, reopened.Update(func(*State) error { return nil }))
	after, err := os.ReadFile(filepath.Join(s.dir, "state.json"))
	must(t, err)
	if len(reopened.Snapshot().Events) != 0 || len(after) >= len(legacy)/2 {
		t.Fatal("expired payload bytes were not reclaimed")
	}
}

func TestStoreRetentionFailedMutationDoesNotPublishCompaction(t *testing.T) {
	s, at := retentionStore(t)
	must(t, s.Update(func(d *State) error { d.Operations["old"] = Operation{State: "complete"}; return nil }))
	before, err := os.ReadFile(filepath.Join(s.dir, "state.json"))
	must(t, err)
	*at = at.Add(terminalRetention)
	aborted := errors.New("synthetic aborted mutation")
	err = s.Update(func(d *State) error {
		if len(d.Operations) != 0 {
			t.Fatal("expired ledger was not reclaimed before admission")
		}
		return aborted
	})
	if !errors.Is(err, aborted) || stateCommitted(err) || len(s.Snapshot().Operations) != 1 {
		t.Fatal("aborted mutation published compaction")
	}
	after, err := os.ReadFile(filepath.Join(s.dir, "state.json"))
	must(t, err)
	if !bytes.Equal(before, after) {
		t.Fatal("aborted mutation changed durable state")
	}
}
