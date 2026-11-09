package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"time"
)

// These are minimum supported horizons, never targets for pressure eviction.
// Reusing an event/request ID after its terminal record expires is a new
// admission. Unresolved source-history cursors extend event dedup indefinitely.
// Return-path lookups/receipt dedup last referenceRetention after remember.
// Outstanding work and the references it needs have no time-based expiry.
const terminalRetention = 7 * 24 * time.Hour
const referenceRetention = 30 * 24 * time.Hour

// LedgerRetention is persisted alongside the ledgers so restarts cannot reset
// the horizon or prematurely forget a completed operation. Missing legacy ages
// start at the first observed transaction, giving them a full grace period.
// Ages are Unix nanoseconds. A future clock value conservatively delays expiry.
type LedgerRetention struct {
	Events     map[string]int64 `json:"events,omitempty"`
	Deliveries map[string]int64 `json:"deliveries,omitempty"`
	Operations map[string]int64 `json:"operations,omitempty"`
	References map[string]int64 `json:"references,omitempty"`
	at         int64
}

func (r *LedgerRetention) init() {
	if r.Events == nil {
		r.Events = map[string]int64{}
	}
	if r.Deliveries == nil {
		r.Deliveries = map[string]int64{}
	}
	if r.Operations == nil {
		r.Operations = map[string]int64{}
	}
	if r.References == nil {
		r.References = map[string]int64{}
	}
}

// remember calls this even when the stored reference itself is unchanged.
func retainReference(d *State, key string) {
	d.Retention.init()
	at := d.Retention.at
	if at == 0 {
		at = time.Now().UnixNano()
	}
	stamp(d.Retention.References, key, at)
}

func stamp(ages map[string]int64, key string, at int64) {
	if at > ages[key] {
		ages[key] = at
	}
}

func refreshAges[T any](ages map[string]int64, records, previous map[string]T, at int64) {
	for key, record := range records {
		old, exists := previous[key]
		if ages[key] == 0 || !exists || !reflect.DeepEqual(record, old) {
			stamp(ages, key, at)
		}
	}
	for key := range ages {
		if _, exists := records[key]; !exists {
			delete(ages, key)
		}
	}
}

func refreshRetention(d *State, previous State, at int64) {
	d.Retention.init()
	refreshAges(d.Retention.Events, d.Events, previous.Events, at)
	refreshAges(d.Retention.Deliveries, d.Deliveries, previous.Deliveries, at)
	refreshAges(d.Retention.Operations, d.Operations, previous.Operations, at)
	refreshAges(d.Retention.References, d.References, previous.References, at)
}

func expired(ages map[string]int64, key string, at int64, horizon time.Duration) bool {
	age := ages[key]
	return age != 0 && age <= at && at-age >= int64(horizon)
}

func terminalDelivery(v Delivery) bool {
	// Polled clients acknowledge transport once the inbox entry is durable.
	// It is still outstanding work until that entry is explicitly consumed.
	return v.Status == "rejected" || (v.Status == "delivered" && v.Transport != "inbox_queued")
}
func terminalOperation(v Operation) bool { return v.State == "complete" || v.State == "terminal" }

// compactLedgers never discards outstanding work to admit a new transaction.
// It is run before admission and again after changes so completion starts a
// fresh dedup horizon, and new/touched records cannot be pressure-evicted.
func compactLedgers(d *State, at int64) {
	r := &d.Retention
	pinnedEvents := map[string]bool{}
	for _, peer := range d.Peers {
		for _, id := range peer.Pending {
			pinnedEvents[id] = true
		}
	}
	for id, record := range d.Events {
		if inboxReferenceHeld(d.References[record.Event.Message.key()]) || feishuHistoryUnresolved(d, record) {
			pinnedEvents[id] = true
		}
		if record.Outcome == "broadcast" {
			for _, peer := range d.Peers {
				// Pending is only a bounded window: unread later broadcasts are
				// just as durable, independently for every subscribed peer.
				if record.Sequence > peer.Cursor && !contains(record.Event.Visited, peer.NodeID) {
					pinnedEvents[id] = true
					break
				}
			}
		}
	}
	for id, delivery := range d.Deliveries {
		if !terminalDelivery(delivery) {
			// Includes pending, retryable, unconfirmed and unknown states.
			pinnedEvents[delivery.EventID] = true
			stamp(r.Deliveries, id, at)
		} else if expired(r.Deliveries, id, at, terminalRetention) {
			delete(d.Deliveries, id)
			delete(r.Deliveries, id)
		}
	}
	for id := range pinnedEvents {
		if _, exists := d.Events[id]; exists {
			stamp(r.Events, id, at)
		}
	}
	// A retained terminal delivery still needs its source event for inspection.
	// Unlike unresolved work, this does not restart the source's age.
	for _, delivery := range d.Deliveries {
		pinnedEvents[delivery.EventID] = true
	}
	for id, operation := range d.Operations {
		if !terminalOperation(operation) {
			stamp(r.Operations, id, at)
		} else if expired(r.Operations, id, at, terminalRetention) {
			delete(d.Operations, id)
			delete(r.Operations, id)
		}
	}
	for id, record := range d.Events {
		terminal := record.Outcome == "local" || record.Outcome == "broadcast" || record.Outcome == "deleted" || record.Outcome == "loop_suppressed"
		if terminal && !pinnedEvents[id] && expired(r.Events, id, at, terminalRetention) {
			delete(d.Events, id)
			delete(r.Events, id)
		}
	}
	pinnedReferences := map[string]bool{}
	for key, reference := range d.References {
		if inboxReferenceHeld(reference) || reference.InboxCancelPending && reference.InboxNodeID == d.NodeID {
			// Only the owner with an actual canceled Node inbox entry waits
			// for durable removal proof. Relays and never-queued work expire
			// normally once their upstream release obligation completes.
			pinnedReferences[key] = true
		}
	}
	for _, record := range d.Events {
		if record.Event.Message.valid() {
			pinnedReferences[record.Event.Message.key()] = true
		}
	}
	for key, operation := range d.Operations {
		var result SendResult
		if json.Unmarshal(operation.Result, &result) == nil && result.Message.valid() {
			pinnedReferences[result.Message.key()] = true
		}
		// A reply intent needs the original return route even if its outcome
		// stays uncertain indefinitely. The JSON message identity is framed
		// before the opaque request ID, which may itself contain colons.
		if strings.HasPrefix(key, "reply:") {
			var identity []string
			decoder := json.NewDecoder(strings.NewReader(strings.TrimPrefix(key, "reply:")))
			if decoder.Decode(&identity) == nil && len(identity) == 3 {
				message := MessageRef{OriginNodeID: identity[0], ProviderID: identity[1], MessageID: identity[2]}
				if message.valid() {
					pinnedReferences[message.key()] = true
				}
			}
		}
	}
	for key := range d.References {
		if !pinnedReferences[key] && expired(r.References, key, at, referenceRetention) {
			delete(d.References, key)
			delete(r.References, key)
		}
	}
}
