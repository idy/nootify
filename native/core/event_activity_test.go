package core

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

func TestCompactedSourceStillAuthorizesSignedNonPolledRelayBacklog(t *testing.T) {
	origin := testCore(t, nil)
	installFake(t, origin, "bot")
	originAddress, originToken := testServer(t, origin)
	relay := testCore(t, nil)
	upstream := addRemote(t, relay, "origin", originAddress, originToken)
	var deliveries atomic.Int32
	owner := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			deliveries.Add(1)
		}
		return nil
	})
	offline, err := relay.Subscribe(context.Background(), owner.node(), "offline non-polled owner")
	must(t, err)
	offline.Close()
	pin, _ := json.Marshal(owner.RemoteIdentity())
	_, err = relay.BindPeer(pin)
	must(t, err)
	await(t, func() bool { return peerStreams(origin, relay.node()) == 1 })
	s := Session{NodeID: owner.node(), Adapter: "codex", SessionID: "long-offline"}
	b, err := origin.Ensure(context.Background(), "bot", s)
	must(t, err)
	e := eventFor(owner.node(), "retained-relay")
	e.Session = b.Session
	e.ChatID = b.ChatID
	e.Message = MessageRef{OriginNodeID: origin.node(), ProviderID: "bot", MessageID: e.ID, ThreadID: "source-thread"}
	must(t, origin.Ingest(context.Background(), e, ""))
	await(t, func() bool {
		_, ok := relay.store.Snapshot().Events[e.ID]
		return ok && len(origin.store.Snapshot().Peers[relay.node()].Pending) == 0
	})
	retained := relay.store.Snapshot().Events[e.ID].Event
	if retained.ActivityProof == "" {
		t.Fatal("origin activity proof was not preserved over gRPC")
	}
	must(t, upstream.Close())
	future := time.Now().Add(45 * 24 * time.Hour)
	origin.store.clock = func() time.Time { return future }
	must(t, origin.store.Update(func(*State) error { return nil }))
	if len(origin.store.Snapshot().Events) != 0 || len(origin.store.Snapshot().References) != 0 {
		t.Fatal("fixture did not compact source payload and reference")
	}
	origin = reopenCore(t, origin, nil)
	originAddress, originToken = testServer(t, origin)
	addRemote(t, relay, "origin", originAddress, originToken)
	await(t, func() bool { return peerStreams(origin, relay.node()) == 1 })
	active, err := origin.EventActive(context.Background(), retained)
	must(t, err)
	if !active {
		t.Fatal("normal source compaction was mistaken for deletion")
	}
	relayAddress, relayToken := testServer(t, relay)
	addRemote(t, owner, "relay", relayAddress, relayToken)
	await(t, func() bool {
		return deliveries.Load() == 1 && len(relay.store.Snapshot().Peers[owner.node()].Pending) == 0
	})
	if owner.store.Snapshot().Events[e.ID].Outcome != "local" {
		t.Fatal("valid compacted source backlog was canceled")
	}
}

func TestSourceActivityProofBindsFullIdentityAndResourceIncarnation(t *testing.T) {
	c := testCore(t, nil)
	installFake(t, c, "bot")
	s := Session{NodeID: "offline-owner", Adapter: "codex", SessionID: "signed"}
	b, err := c.Ensure(context.Background(), "bot", s)
	must(t, err)
	e := eventFor(s.NodeID, "signed-event")
	e.Session = b.Session
	e.ChatID = b.ChatID
	e.SenderID = "trusted"
	e.Message = MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: e.ID, ThreadID: "thread"}
	must(t, c.Ingest(context.Background(), e, ""))
	e = c.store.Snapshot().Events[e.ID].Event
	must(t, c.store.Update(func(d *State) error { delete(d.Events, e.ID); delete(d.References, e.Message.key()); return nil }))
	active, err := c.EventActive(context.Background(), e)
	must(t, err)
	if !active {
		t.Fatal("signed activity proof did not survive payload removal")
	}
	for _, change := range []struct {
		name   string
		mutate func(*Event)
	}{
		{"event", func(v *Event) { v.ID = "invented" }},
		{"session", func(v *Event) { v.Session.SessionID = "invented" }},
		{"adapter", func(v *Event) { v.Session.Adapter = "trae" }},
		{"message", func(v *Event) { v.Message.MessageID = "invented" }},
		{"provider", func(v *Event) { v.Message.ProviderID = "other" }},
		{"chat", func(v *Event) { v.ChatID = "replacement-chat" }},
		{"thread", func(v *Event) { v.Message.ThreadID = "other-thread" }},
		{"sender", func(v *Event) { v.SenderID = "other-sender" }},
		{"content", func(v *Event) { v.Content.Text = "invented command" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			altered := e
			change.mutate(&altered)
			active, err := c.EventActive(context.Background(), altered)
			if active || err == nil {
				t.Fatal("activity proof authorized an invented event identity")
			}
		})
	}
	legacy := e
	legacy.ActivityProof = ""
	active, err = c.EventActive(context.Background(), legacy)
	if active || publicError(err).Code != "unavailable" {
		t.Fatal("missing legacy activity proof was reported as authoritative cancellation")
	}
	must(t, c.Delete(context.Background(), "bot", s))
	active, err = c.EventActive(context.Background(), e)
	must(t, err)
	if active {
		t.Fatal("valid signature overrode an authoritative resource tombstone")
	}
	installFake(t, c, "replacement")
	_, err = c.Ensure(context.Background(), "replacement", s)
	must(t, err)
	active, err = c.EventActive(context.Background(), e)
	must(t, err)
	if active {
		t.Fatal("explicit reactivation resurrected a signature for a retired resource")
	}
}
