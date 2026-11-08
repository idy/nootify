package main

import "sort"

// A peer's Pending is a bounded delivery window, not the complete backlog.
// The bounded durable event ledger retains later broadcasts until that peer's
// cursor advances. Full windows never veto admission for other subscribers.
func broadcastLog(d *State) []EventRecord {
	log := make([]EventRecord, 0, len(d.Events))
	for _, record := range d.Events {
		if record.Sequence != 0 {
			log = append(log, record)
		}
	}
	sort.Slice(log, func(i, j int) bool { return log[i].Sequence < log[j].Sequence })
	return log
}
func refillPeer(peer Peer, log []EventRecord) Peer {
	for _, record := range log {
		if record.Sequence <= peer.Cursor {
			continue
		}
		if record.Outcome != "broadcast" || contains(record.Event.Visited, peer.NodeID) {
			peer.Cursor = record.Sequence
			continue
		}
		if len(peer.Pending) >= maxPending {
			break
		}
		peer.Pending = append(peer.Pending, record.Event.ID)
		peer.Cursor = record.Sequence
	}
	return peer
}
func pendingCount(peer Peer, log []EventRecord) int {
	n := len(peer.Pending)
	for _, record := range log {
		if record.Sequence > peer.Cursor && record.Outcome == "broadcast" && !contains(record.Event.Visited, peer.NodeID) {
			n++
		}
	}
	return n
}
