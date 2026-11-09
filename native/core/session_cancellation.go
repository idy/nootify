package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
)

// Cancel only work proven not to have reached the agent. Unknown/pending
// submissions retain their evidence until their outcome is resolved.
func cancelEvent(d *State, id string) {
	record, ok := d.Events[id]
	if !ok {
		return
	}
	record.Outcome = "deleted"
	d.Events[id] = record
	uncertain := false
	queuedLocally := false
	for key, delivery := range d.Deliveries {
		if delivery.EventID != id {
			continue
		}
		switch {
		case delivery.Status == "retryable", delivery.Status == "delivered" && delivery.Transport == "inbox_queued":
			if delivery.Status == "delivered" && delivery.Transport == "inbox_queued" && record.Event.Session.NodeID == d.NodeID {
				queuedLocally = true
			}
			delivery.Status, delivery.Transport, delivery.Error = "rejected", "deleted", ""
			d.Deliveries[key] = delivery
		case delivery.Status == "pending" || delivery.Status == "unconfirmed":
			uncertain = true
		}
	}
	if !uncertain {
		markInboxConsumed(d, record.Event.Message)
		key := record.Event.Message.key()
		r := d.References[key]
		r.InboxCanceled = true
		if queuedLocally && !r.InboxCancelPending {
			r.InboxUpdatedAt = nextInboxStamp(d, r.InboxUpdatedAt)
		}
		r.InboxCancelPending = r.InboxCancelPending || queuedLocally
		d.References[key] = r
	}
}

func cancellationEvent(b Binding) Event {
	b.Aliases = nil
	hash := sha256.Sum256([]byte(resourceKey(b)))
	id := "cancel:" + hex.EncodeToString(hash[:])
	return Event{ID: id, Session: b.Session, Message: MessageRef{OriginNodeID: b.ResourceNodeID, ProviderID: b.ResourceProviderID, MessageID: id}, Hops: 16, Cancellation: &b}
}

// Tombstones are a permanent resource snapshot, independent of data-event
// acknowledgments and ledger expiry. Every subscription offers them first.
func (s *Subscription) nextCancellation(d State) (Event, bool) {
	keys := make([]string, 0, len(d.RetiredBindings))
	for key := range d.RetiredBindings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if s.cancellations == nil {
		s.cancellations = map[string]bool{}
	}
	for _, key := range keys {
		b := d.RetiredBindings[key]
		if b.ResourceNodeID == "" || b.ResourceProviderID == "" || b.ChatID == "" {
			continue
		}
		e := cancellationEvent(b)
		if !s.cancellations[e.ID] {
			s.cancellations[e.ID] = true
			return e, true
		}
	}
	return Event{}, false
}

func (c *Core) ingestCancellation(ctx context.Context, e Event) error {
	b := *e.Cancellation
	if err := b.Session.validate(); err != nil {
		return err
	}
	if b.ChatID == "" || b.ResourceNodeID == "" || b.ResourceProviderID == "" || e.ID != cancellationEvent(b).ID || e.Session.key() != b.Session.key() || e.Message.OriginNodeID != b.ResourceNodeID || e.Message.ProviderID != b.ResourceProviderID {
		return fault("invalid_argument", "invalid cancellation resource")
	}
	unlock, err := c.sessions.acquire(ctx, b.Session.key())
	if err != nil {
		return err
	}
	defer unlock()
	changed := false
	err = c.store.Update(func(d *State) error {
		key := resourceKey(b)
		if _, exists := d.RetiredBindings[key]; !exists {
			changed = true
		}
		b.Deleted = true
		b.Aliases = nil
		d.RetiredBindings[key] = b
		for id, record := range d.Events {
			if retiredResource(d, record.Event) {
				cancelEvent(d, id)
			}
		}
		pruneCanceledPeers(d)
		return nil
	})
	if stateCommitted(err) && changed {
		c.wakePeers()
	}
	return err
}

func pruneCanceledPeers(d *State) {
	log := broadcastLog(d)
	for node, peer := range d.Peers {
		pending := make([]string, 0, len(peer.Pending))
		for _, id := range peer.Pending {
			if d.Events[id].Outcome != "deleted" {
				pending = append(pending, id)
			}
		}
		peer.Pending = pending
		d.Peers[node] = refillPeer(peer, log)
	}
}

type eventValidator interface {
	EventActive(context.Context, Event) (bool, error)
}

func (p *remoteProvider) EventActive(ctx context.Context, e Event) (bool, error) {
	var result struct {
		Active bool `json:"active"`
	}
	err := p.call(ctx, "event.active", map[string]any{"event": e}, &result)
	return result.Active, err
}

// Only the source can authorize a stale queued event. A disconnected relay
// keeps the delivery retryable rather than assuming its cached state is current.
func (c *Core) EventActive(ctx context.Context, e Event) (bool, error) {
	if e.ID == "" || !e.Message.valid() || e.Session.validate() != nil {
		return false, fault("invalid_argument", "full source event identity is required")
	}
	d, err := c.store.DurableSnapshot()
	if err != nil {
		return false, err
	}
	if retiredResource(&d, e) {
		return false, nil
	}
	if e.Message.OriginNodeID == d.NodeID {
		r, ok := d.Events[e.ID]
		if !ok {
			return false, nil
		}
		if r.Event.Session.key() != e.Session.key() || r.Event.Message.key() != e.Message.key() || r.Event.ChatID != e.ChatID || r.Event.Message.ThreadID != e.Message.ThreadID {
			return false, fault("conflict", "source event identity differs")
		}
		return r.Outcome != "deleted", nil
	}
	r, ok := d.References[e.Message.key()]
	if !ok {
		return false, fault("unavailable", "source return route is unavailable")
	}
	var first error
	for _, route := range r.Routes {
		p, err := c.provider(route)
		if err != nil {
			first = err
			continue
		}
		validator, ok := p.(eventValidator)
		if !ok {
			first = fault("unavailable", "source cannot validate event")
			continue
		}
		active, err := validator.EventActive(ctx, e)
		if err == nil {
			return active, nil
		}
		first = err
	}
	if first == nil {
		first = fault("unavailable", "source resource status cannot be confirmed")
	}
	return false, first
}
