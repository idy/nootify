package core

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idy/nootify/native/core/pb"
)

func TestDeletionCrossesConfirmedRelayAndRestartBeforeOfflineOwnerReplay(t *testing.T) {
	for _, mode := range []string{"session", "provider"} {
		t.Run(mode, func(t *testing.T) {
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
			// Owner subscribed previously, but is offline during source input and deletion.
			offline, err := relay.Subscribe(context.Background(), owner.node(), "offline owner")
			must(t, err)
			offline.Close()
			identity := owner.RemoteIdentity()
			pin, _ := json.Marshal(identity)
			_, err = relay.BindPeer(pin)
			must(t, err)
			await(t, func() bool { return peerStreams(origin, relay.node()) == 1 })
			s := Session{NodeID: owner.node(), Adapter: "trae", SessionID: "deleted-" + mode}
			b, err := origin.Ensure(context.Background(), "bot", s)
			must(t, err)
			e := eventFor(owner.node(), "old-input-"+mode)
			e.Session = b.Session
			e.ChatID = b.ChatID
			e.Message = MessageRef{OriginNodeID: origin.node(), ProviderID: "bot", MessageID: e.ID}
			must(t, origin.Ingest(context.Background(), e, ""))
			await(t, func() bool {
				_, ok := relay.store.Snapshot().Events[e.ID]
				return ok && len(origin.store.Snapshot().Peers[relay.node()].Pending) == 0
			})
			must(t, upstream.Close())
			if mode == "session" {
				must(t, origin.Delete(context.Background(), "bot", s))
			} else {
				must(t, origin.DeleteProvider("bot"))
			}
			// Both durable nodes restart while the origin-to-relay link is down.
			origin = reopenCore(t, origin, nil)
			originAddress, originToken = testServer(t, origin)
			relay = reopenCore(t, relay, nil)
			relayAddress, relayToken := testServer(t, relay)
			addRemote(t, owner, "relay", relayAddress, relayToken)
			await(t, func() bool { d := owner.store.Snapshot(); _, ok := d.Events[e.ID]; return ok && len(d.Deliveries) == 1 })
			if deliveries.Load() != 0 {
				t.Fatal("offline relay authorized stale input before source synchronization")
			}
			for _, v := range owner.store.Snapshot().Deliveries {
				if v.Status != "retryable" {
					t.Fatal("unavailable origin lost safe dispatch proof")
				}
			}
			addRemote(t, relay, "origin", originAddress, originToken)
			await(t, func() bool {
				return relay.store.Snapshot().Events[e.ID].Outcome == "deleted" && owner.store.Snapshot().Events[e.ID].Outcome == "deleted"
			})
			if deliveries.Load() != 0 {
				t.Fatal("completed deletion executed stale command across relay")
			}
			for _, v := range owner.store.Snapshot().Deliveries {
				if v.Status != "rejected" {
					t.Fatal("canceled undispatched delivery kept an outstanding obligation")
				}
			}
		})
	}
}

func TestCancellationSnapshotPrecedesBacklogAndScopesReactivation(t *testing.T) {
	c := testCore(t, nil)
	installFake(t, c, "bot")
	s := Session{NodeID: "owner", Adapter: "codex", SessionID: "reactivation"}
	old, err := c.Ensure(context.Background(), "bot", s)
	must(t, err)
	peer, err := c.Subscribe(context.Background(), "downstream", "")
	must(t, err)
	defer peer.Close()
	e := eventFor("owner", "old")
	e.Session = old.Session
	e.ChatID = old.ChatID
	e.Message = MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: e.ID}
	must(t, c.Ingest(context.Background(), e, ""))
	must(t, c.Delete(context.Background(), "bot", s))
	fresh, err := c.Ensure(context.Background(), "bot", s)
	must(t, err)
	current := e
	current.ID = "new"
	current.Message.MessageID = "new"
	current.ChatID = fresh.ChatID
	must(t, c.Ingest(context.Background(), current, ""))
	first, err := peer.Next()
	must(t, err)
	if first.Cancellation == nil || first.Cancellation.ChatID != old.ChatID {
		t.Fatal("cancellation did not precede ordinary backlog")
	}
	must(t, peer.Confirm(first.ID)) // Controls are snapshot acknowledgments, not data Pending IDs.
	next, err := peer.Next()
	must(t, err)
	if next.ID != "new" || next.Cancellation != nil {
		t.Fatal("old cancellation suppressed explicit replacement resource")
	}
	relay := testCore(t, nil)
	must(t, relay.Ingest(context.Background(), first, "origin"))
	must(t, relay.Ingest(context.Background(), current, "origin"))
	if relay.store.Snapshot().Events[current.ID].Outcome != "broadcast" {
		t.Fatal("resource tombstone blocked a new incarnation")
	}
}

func TestCancellationWireConfirmationKeepsAuthenticatedStreamUsable(t *testing.T) {
	c := testCore(t, nil)
	installFake(t, c, "bot")
	s := Session{NodeID: "owner", Adapter: "codex", SessionID: "wire-cancellation"}
	old, err := c.Ensure(context.Background(), "bot", s)
	must(t, err)
	must(t, c.Delete(context.Background(), "bot", s))
	address, token := testServer(t, c)
	stream, _, _ := authenticatedStreamClient(t, address, token, "subscriber")
	frame, err := stream.Recv()
	must(t, err)
	control, err := parseEvent(frame.GetEvent())
	must(t, err)
	if control.Cancellation == nil || control.Cancellation.ChatID != old.ChatID {
		t.Fatal("wire lost cancellation resource")
	}
	must(t, stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: control.ID}}}))
	fresh, err := c.Ensure(context.Background(), "bot", s)
	must(t, err)
	e := eventFor("owner", "wire-new")
	e.Session = fresh.Session
	e.ChatID = fresh.ChatID
	e.Message = MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: e.ID}
	must(t, c.Ingest(context.Background(), e, ""))
	frame, err = stream.Recv()
	must(t, err)
	if frame.GetEvent() == nil || frame.GetEvent().EventId != e.ID {
		t.Fatal("control confirmation interrupted ordinary subscription")
	}
	must(t, stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: e.ID}}}))
	await(t, func() bool { return len(c.store.Snapshot().Peers["subscriber"].Pending) == 0 })
	if peerStreams(c, "subscriber") != 1 {
		t.Fatal("cancellation confirmation killed the authenticated stream")
	}
}

func TestCanceledWorkReleasesKnownSafeHoldsButRetainsUncertainty(t *testing.T) {
	c := testCore(t, func(string, any) error { return nil })
	installFake(t, c, "bot")
	s := Session{Adapter: "trae", SessionID: "cancel-retention"}
	b, err := c.Ensure(context.Background(), "bot", s)
	must(t, err)
	ids := map[string]string{}
	for _, status := range []string{"retryable", "unconfirmed", "pending", "queued"} {
		e := eventFor(c.node(), status)
		e.Session = b.Session
		e.ChatID = b.ChatID
		e.Message = MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: status}
		must(t, c.Ingest(context.Background(), e, ""))
		for id, v := range c.store.Snapshot().Deliveries {
			if v.EventID == status {
				ids[status] = id
			}
		}
		switch status {
		case "queued":
			must(t, c.Complete(ids[status], "delivered", "inbox_queued", ""))
		case "pending":
		default:
			must(t, c.Complete(ids[status], status, "fixture", ""))
		}
	}
	must(t, c.Delete(context.Background(), "bot", s))
	d := c.store.Snapshot()
	for _, status := range []string{"retryable", "queued"} {
		if d.Deliveries[ids[status]].Status != "rejected" || d.References[(MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: status}).key()].InboxState == "pending" {
			t.Fatal("canceled known-safe work retained an outstanding hold")
		}
	}
	for _, status := range []string{"pending", "unconfirmed"} {
		if d.Deliveries[ids[status]].Status != status {
			t.Fatal("cancellation erased actual submission uncertainty")
		}
	}
	// Confirmed cancellation receipts can complete locally without waiting for
	// an inbox callback; only genuine unknown submissions stay pinned.
	for _, status := range []string{"retryable", "queued"} {
		ref := MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: status}
		for _, consumed := range []bool{false, true} {
			if consumed {
				must(t, c.ReleaseInbox(context.Background(), ref))
			}
			r := c.store.Snapshot().References[ref.key()]
			before, _ := json.Marshal(map[string]any{"before": r.InboxUpdatedAt + 1000, "pending": []any{map[string]any{"message": ref}}})
			must(t, c.ReconcileInbox(context.Background(), before))
			if after := c.store.Snapshot().References[ref.key()]; after.InboxState != r.InboxState || !after.InboxCanceled {
				t.Fatal("newer queue snapshot reopened a canceled hold")
			}
		}
	}
	now := time.Now().Add(terminalRetention + time.Hour)
	c.store.clock = func() time.Time { return now }
	must(t, c.store.Update(func(*State) error { return nil }))
	for _, status := range []string{"retryable", "queued"} {
		if _, ok := c.store.Snapshot().Deliveries[ids[status]]; ok {
			t.Fatal("canceled terminal delivery failed normal retention")
		}
	}
	for _, status := range []string{"pending", "unconfirmed"} {
		if _, ok := c.store.Snapshot().Deliveries[ids[status]]; !ok {
			t.Fatal("uncertain submission evidence expired")
		}
	}
}
