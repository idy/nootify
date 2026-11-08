package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

func resourceKey(b Binding) string {
	raw, _ := json.Marshal([]string{b.Session.key(), b.ResourceNodeID, b.ResourceProviderID, b.ProviderID, b.ChatID, b.ThreadID})
	return string(raw)
}
func sameResource(a, b Binding) bool {
	if a.ChatID == "" || b.ChatID == "" || a.ChatID != b.ChatID || a.Session.key() != b.Session.key() {
		return false
	}
	if a.ResourceNodeID != "" && b.ResourceNodeID != "" && a.ResourceNodeID != b.ResourceNodeID {
		return false
	}
	return a.ThreadID == b.ThreadID
}
func retiredResource(d *State, event Event) bool {
	for _, old := range d.RetiredBindings {
		if old.Session.key() != event.Session.key() {
			continue
		}
		if old.ResourceNodeID != "" && old.ResourceNodeID != event.Message.OriginNodeID {
			continue
		}
		if event.ChatID != "" && old.ChatID == event.ChatID {
			return true
		}
		if event.ChatID == "" && old.ResourceProviderID != "" && old.ResourceProviderID == event.Message.ProviderID {
			return true
		}
	}
	return false
}
func setResourceOrigin(d State, b *Binding, node string) {
	if b.ResourceNodeID != "" {
		return
	}
	if config, ok := d.Providers[b.ProviderID]; ok && config.Type == "feishu" {
		b.ResourceNodeID = node
		b.ResourceProviderID = b.ProviderID
	}
}
func wasRetired(d State, b Binding) bool {
	for _, old := range d.RetiredBindings {
		if sameResource(old, b) {
			return true
		}
	}
	return false
}

// The operation gate must be held. A failed/uncertain delete can be retried
// idempotently, but no replacement is created while cleanup is unresolved on a
// configured provider. Removing that provider permits an explicit move; its
// retired resource remains permanently suppressed and is never re-adopted.
func (c *Core) prepareSession(ctx context.Context, pid string, s Session) (Binding, string, bool, error) {
	d := c.store.Snapshot()
	b, exists := d.Bindings[s.key()]
	if exists && !b.Deleted {
		if _, configured := d.Providers[b.ProviderID]; configured {
			if pid != "" && pid != b.ProviderID {
				return b, pid, false, fault("conflict", "session is bound to a different provider")
			}
			b.Created = false
			return b, b.ProviderID, true, nil
		}
		if automaticEnsure(ctx) {
			return b, pid, false, fault("unavailable", "session provider was removed; an explicit rebind is required")
		}
		b.Deleted = true
		b.DeletePending = b.ChatID != ""
		if err := c.store.Update(func(d *State) error { recordTombstone(d, b); return nil }); err != nil {
			return b, pid, false, err
		}
		d = c.store.Snapshot()
	}
	if exists && b.Deleted && automaticEnsure(ctx) {
		return b, pid, false, fault("deleted", "automatic enrollment cannot reactivate a deleted session")
	}
	if pid == "" {
		if _, configured := d.Providers[b.ProviderID]; exists && configured {
			pid = b.ProviderID
		} else {
			pid = d.DefaultProvider
		}
	}
	// Check the destination first: never clean up a live provider solely to
	// discover that the requested replacement cannot operate.
	if _, err := c.provider(pid); err != nil {
		return b, pid, false, err
	}
	if exists && b.DeletePending {
		if _, configured := d.Providers[b.ProviderID]; configured {
			if err := c.cleanupBinding(ctx, &b); err != nil {
				return b, pid, false, err
			}
		} else if pid == b.ProviderID {
			return b, pid, false, fault("unavailable", "removed provider cannot reactivate its retired resources")
		}
	}
	return b, pid, false, nil
}
func (c *Core) cleanupBinding(ctx context.Context, b *Binding) error {
	p, err := c.provider(b.ProviderID)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = p.Delete(ctx, *b); err != nil {
		return err
	}
	b.DeletePending = false
	return c.store.Update(func(d *State) error {
		d.Bindings[b.Session.key()] = *b
		key := resourceKey(*b)
		if old, ok := d.RetiredBindings[key]; ok {
			old.DeletePending = false
			d.RetiredBindings[key] = old
		}
		return nil
	})
}
func (c *Core) wakePeers() {
	for node := range c.store.Snapshot().Peers {
		c.wake(node)
	}
}

// A deterministic incarnation component prevents Feishu's create UUID from
// returning the retired group after an explicit reactivation. It is stable
// across an uncertain create/restart until that resource is itself retired.
func resourceIncarnation(d State, s Session) string {
	keys := []string{}
	for key, b := range d.RetiredBindings {
		if b.Session.key() == s.key() {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)
	hash := sha256.Sum256([]byte(strings.Join(keys, "\n")))
	return hex.EncodeToString(hash[:])
}
