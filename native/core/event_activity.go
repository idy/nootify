package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
)

// A chat identity is an immutable resource incarnation: retired chat resources
// cannot be adopted again. The origin signs this identity together with the
// message and session, so a relay cannot invent a replacement event after GC.
func activityIdentity(e Event) []byte {
	resource, _ := json.Marshal([]string{e.Session.key(), e.Message.OriginNodeID, e.Message.ProviderID, e.ChatID})
	incarnation := sha256.Sum256(resource)
	payload, _ := json.Marshal([]any{e.Content, e.SenderID})
	digest := sha256.Sum256(payload)
	raw, _ := json.Marshal([]string{"nootify-event-active:v1", hex.EncodeToString(incarnation[:]), e.ID, e.Session.key(), e.Message.OriginNodeID, e.Message.ProviderID, e.Message.MessageID, e.Message.ThreadID, e.ChatID, hex.EncodeToString(digest[:])})
	return raw
}

func signActivity(d *State, e *Event) {
	if e.Message.OriginNodeID != d.NodeID || e.ChatID == "" || e.Cancellation != nil {
		return
	}
	private, err := base64.StdEncoding.DecodeString(d.NodePrivateKey)
	if err != nil || len(private) != ed25519.PrivateKeySize {
		return
	}
	e.ActivityProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(ed25519.PrivateKey(private), activityIdentity(*e)))
}

// Snapshot authoritative source proofs exactly once, before the first retention
// sweep after upgrade. A relay may already have confirmed an older unsigned
// frame; signing the source event alone cannot update that durable remote copy.
// Retain only compact signatures, not payloads or callback routes, independently
// of normal ledger GC. Empty-but-non-nil is the persisted migration marker, so
// new signed traffic does not grow this compatibility ledger on every restart.
func backfillLegacyActivityProofs(d *State) error {
	if d.LegacyActivityProofs != nil {
		return nil
	}
	if err := ensureNodeIdentity(d); err != nil {
		return err
	}
	proofs := map[string]string{}
	for key, reference := range d.References {
		if reference.Message.OriginNodeID == d.NodeID && reference.ActivityProof != "" {
			// An intermediate release may already have compacted the payload
			// after signing it, while the confirmed relay frame stayed unsigned.
			proofs[key] = reference.ActivityProof
		}
	}
	for id, record := range d.Events {
		e := record.Event
		if e.Message.OriginNodeID != d.NodeID || e.ChatID == "" || e.Cancellation != nil {
			continue
		}
		signActivity(d, &e)
		if e.ActivityProof == "" {
			continue
		}
		record.Event = e
		d.Events[id] = record
		proofs[e.Message.key()] = e.ActivityProof
	}
	d.LegacyActivityProofs = proofs
	return nil
}

func validActivity(d State, e Event, proof string) bool {
	private, err := base64.StdEncoding.DecodeString(d.NodePrivateKey)
	if err != nil || len(private) != ed25519.PrivateKeySize {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(proof)
	return err == nil && ed25519.Verify(ed25519.PrivateKey(private).Public().(ed25519.PublicKey), activityIdentity(e), sig)
}

func activeResource(d State, e Event) bool {
	binding, ok := d.Bindings[e.Session.key()]
	if !ok || binding.Deleted {
		return false
	}
	source, ok := d.Providers[e.Message.ProviderID]
	if !ok || source.Type != "feishu" {
		return false
	}
	for _, b := range bindingResources(binding) {
		cfg := d.Providers[b.ProviderID]
		if !b.Deleted && b.ChatID == e.ChatID && b.Session.key() == e.Session.key() && cfg.Type == "feishu" && cfg.AppID == source.AppID && (b.ResourceNodeID == "" || b.ResourceNodeID == e.Message.OriginNodeID) {
			return true
		}
	}
	return false
}
