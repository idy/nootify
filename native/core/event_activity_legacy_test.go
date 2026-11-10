package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestLegacyConfirmedRelayBacklogSurvivesSourceProofMigrationAndCompaction(t *testing.T) {
	for _, mode := range []string{"unsigned-source-event", "previously-signed-reference-only"} {
		t.Run(mode, func(t *testing.T) {
			origin := testCore(t, nil)
			installFake(t, origin, "bot")
			address, token := testServer(t, origin)
			relay := testCore(t, nil)
			upstream := addRemote(t, relay, "origin", address, token)
			var deliveries atomic.Int32
			owner := testCore(t, func(name string, _ any) error {
				if name == "delivery" {
					deliveries.Add(1)
				}
				return nil
			})
			offline, err := relay.Subscribe(context.Background(), owner.node(), "legacy offline owner")
			must(t, err)
			offline.Close()
			pin, _ := json.Marshal(owner.RemoteIdentity())
			_, err = relay.BindPeer(pin)
			must(t, err)
			await(t, func() bool { return peerStreams(origin, relay.node()) == 1 })
			session := Session{NodeID: owner.node(), Adapter: "codex", SessionID: "legacy-backlog"}
			binding, err := origin.Ensure(context.Background(), "bot", session)
			must(t, err)
			event := eventFor(owner.node(), "legacy-confirmed-relay")
			event.Session = binding.Session
			event.ChatID = binding.ChatID
			event.SenderID = "trusted"
			event.SourceCreatedAt = time.Now().Add(-60 * 24 * time.Hour).UnixMilli()
			event.Message = MessageRef{OriginNodeID: origin.node(), ProviderID: "bot", MessageID: event.ID, ThreadID: "legacy-thread"}
			must(t, origin.Ingest(context.Background(), event, ""))
			await(t, func() bool {
				_, exists := relay.store.Snapshot().Events[event.ID]
				return exists && len(origin.store.Snapshot().Peers[relay.node()].Pending) == 0
			})
			must(t, upstream.Close())
			// Model the already-confirmed frame persisted by a pre-proof relay.
			must(t, relay.store.Update(func(d *State) error {
				record := d.Events[event.ID]
				record.Event.ActivityProof = ""
				d.Events[event.ID] = record
				reference := d.References[event.Message.key()]
				reference.ActivityProof = ""
				d.References[event.Message.key()] = reference
				return nil
			}))
			legacy := relay.store.Snapshot().Events[event.ID].Event
			relay = reopenCore(t, relay, nil)
			origin.Close()
			old := origin.store.Snapshot()
			must(t, origin.store.Close())
			if mode == "unsigned-source-event" {
				record := old.Events[event.ID]
				record.Event.ActivityProof = ""
				old.Events[event.ID] = record
				reference := old.References[event.Message.key()]
				reference.ActivityProof = ""
				old.References[event.Message.key()] = reference
			} else {
				// Also upgrade the intermediate release which signed source
				// records without refreshing already-confirmed relay frames.
				delete(old.Events, event.ID)
			}
			age := time.Now().Add(-45 * 24 * time.Hour).UnixNano()
			old.Retention.Events[event.ID] = age
			old.Retention.References[event.Message.key()] = age
			// Source history is completely covered, so only the compatibility
			// proof migration can preserve this already-confirmed remote work.
			old.FeishuCursors[feishuCursorKey("app", event.ChatID)] = event.SourceCreatedAt + 60000
			raw, err := json.Marshal(old)
			must(t, err)
			var preMigration map[string]json.RawMessage
			must(t, json.Unmarshal(raw, &preMigration))
			delete(preMigration, "legacy_activity_proofs")
			raw, err = json.Marshal(preMigration)
			must(t, err)
			must(t, os.WriteFile(filepath.Join(origin.store.dir, "state.json"), raw, 0600))
			store, err := OpenStore(origin.store.dir)
			must(t, err)
			origin, err = NewCore(context.Background(), store, nil)
			must(t, err)
			t.Cleanup(func() { origin.Close(); _ = store.Close() })
			future := time.Now().Add(90 * 24 * time.Hour)
			origin.store.clock = func() time.Time { return future }
			must(t, origin.store.Update(func(*State) error { return nil }))
			if len(origin.store.Snapshot().Events) != 0 || len(origin.store.Snapshot().References) != 0 {
				t.Fatal("fixture did not compact the normal source payload/reference ledgers")
			}
			origin = reopenCore(t, origin, nil)
			active, err := origin.EventActive(context.Background(), legacy)
			must(t, err)
			if !active {
				t.Fatal("legacy relay event lost authoritative activity during source migration")
			}
			for _, mutate := range []func(*Event){
				func(e *Event) { e.Content.Text = "invented command" },
				func(e *Event) { e.SenderID = "other sender" },
				func(e *Event) { e.Session.SessionID = "other session" },
				func(e *Event) { e.ChatID = "replacement chat" },
				func(e *Event) { e.Message.ThreadID = "replacement thread" },
			} {
				altered := legacy
				mutate(&altered)
				active, err := origin.EventActive(context.Background(), altered)
				if active || err == nil {
					t.Fatal("legacy proof recovery authorized an altered event")
				}
			}
			address, token = testServer(t, origin)
			addRemote(t, relay, "origin", address, token)
			await(t, func() bool { return peerStreams(origin, relay.node()) == 1 })
			relayAddress, relayToken := testServer(t, relay)
			addRemote(t, owner, "relay", relayAddress, relayToken)
			await(t, func() bool {
				return deliveries.Load() == 1 && len(relay.store.Snapshot().Peers[owner.node()].Pending) == 0
			})
			installFake(t, origin, "bot")
			must(t, origin.Delete(context.Background(), "bot", session))
			active, err = origin.EventActive(context.Background(), legacy)
			must(t, err)
			if active {
				t.Fatal("migration proof overrode resource retirement")
			}
		})
	}
}

func TestLegacyProofMigrationDoesNotGrowWithNewTrafficAfterRestart(t *testing.T) {
	origin := testCore(t, nil)
	installFake(t, origin, "bot")
	session := Session{NodeID: "offline-owner", Adapter: "codex", SessionID: "proof-migration-once"}
	binding, err := origin.Ensure(context.Background(), "bot", session)
	must(t, err)
	legacy := eventFor(session.NodeID, "pre-upgrade")
	legacy.Session, legacy.ChatID = session, binding.ChatID
	legacy.SourceCreatedAt = time.Now().UnixMilli()
	legacy.Message = MessageRef{OriginNodeID: origin.node(), ProviderID: "bot", MessageID: legacy.ID}
	must(t, origin.Ingest(context.Background(), legacy, ""))
	// Model state written before this one-time migration was introduced.
	must(t, origin.store.Update(func(d *State) error { d.LegacyActivityProofs = nil; return nil }))
	origin = reopenCore(t, origin, nil)
	modern := legacy
	modern.ID, modern.Message.MessageID = "post-upgrade", "post-upgrade"
	must(t, origin.Ingest(context.Background(), modern, ""))
	signed := origin.store.Snapshot().Events[modern.ID].Event
	origin = reopenCore(t, origin, nil)
	must(t, origin.store.Update(func(d *State) error {
		d.FeishuCursors[feishuCursorKey("app", binding.ChatID)] = legacy.SourceCreatedAt + 60000
		return nil
	}))
	future := time.Now().Add(90 * 24 * time.Hour)
	origin.store.clock = func() time.Time { return future }
	must(t, origin.store.Update(func(*State) error { return nil }))
	if len(origin.store.Snapshot().Events) != 0 || len(origin.store.Snapshot().References) != 0 {
		t.Fatal("source ledgers did not expire after covered history")
	}
	active, err := origin.EventActive(context.Background(), legacy)
	must(t, err)
	if !active {
		t.Fatal("pre-upgrade compatibility proof was not retained")
	}
	active, err = origin.EventActive(context.Background(), modern)
	if active || publicError(err).Code != "unavailable" {
		t.Fatal("restart added new traffic to the permanent compatibility ledger")
	}
	active, err = origin.EventActive(context.Background(), signed)
	must(t, err)
	if !active {
		t.Fatal("modern signed frame stopped working without compatibility receipts")
	}
}
