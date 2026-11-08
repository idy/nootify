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
func bindingState(d State, s Session) string {
	b, exists := d.Bindings[s.key()]
	if !exists {
		return ""
	}
	raw, _ := json.Marshal(b)
	return string(raw)
}

// Provider configuration and the expected session mapping are captured under
// the short configuration gate. No node-wide gate is held during provider RPCs.
// A changed instance/configuration cannot publish an obsolete mapping afterward.
type providerLease struct {
	ID           string
	Config       ProviderConfig
	Bot          Provider
	Binding      Binding
	BindingState string
}

func (c *Core) captureProvider(ctx context.Context, pid string, s Session) (providerLease, error) {
	if err := c.ops.LockContext(ctx); err != nil {
		return providerLease{}, err
	}
	defer c.ops.Unlock()
	d := c.store.Snapshot()
	config, exists := d.Providers[pid]
	if !exists {
		return providerLease{}, fault("unavailable", "provider configuration is unavailable")
	}
	bot, err := c.provider(pid)
	if err != nil {
		return providerLease{}, err
	}
	return providerLease{ID: pid, Config: config, Bot: bot, Binding: d.Bindings[s.key()], BindingState: bindingState(d, s)}, nil
}
func (c *Core) leaseCurrent(d State, lease providerLease) bool {
	config, exists := d.Providers[lease.ID]
	if !exists || config != lease.Config {
		return false
	}
	c.mu.Lock()
	current := c.providers[lease.ID]
	c.mu.Unlock()
	return current == lease.Bot
}
func (c *Core) publishBinding(lease providerLease, b Binding) (Binding, error) {
	c.ops.Lock()
	defer c.ops.Unlock()
	if b.ResourceNodeID == "" && lease.Config.Type == "feishu" {
		b.ResourceNodeID = c.node()
		b.ResourceProviderID = lease.ID
	}
	conflict := false
	err := c.store.Update(func(d *State) error {
		current := bindingState(*d, b.Session)
		if !c.leaseCurrent(*d, lease) || current != lease.BindingState {
			// Creation may have succeeded while its provider was removed/replaced.
			// Retire the result durably; never resurrect a newer binding or tombstone.
			conflict = true
			b.Deleted = true
			b.DeletePending = b.ChatID != ""
			if b.ChatID != "" {
				d.RetiredBindings[resourceKey(b)] = b
			}
			if current == lease.BindingState {
				recordTombstone(d, b)
			}
			return nil
		}
		if wasRetired(*d, b) {
			return fault("conflict", "provider returned a retired notification resource")
		}
		d.Bindings[b.Session.key()] = b
		return nil
	})
	if err != nil {
		return b, err
	}
	if conflict {
		return b, fault("conflict", "provider or session changed while creating the notification resource")
	}
	return b, nil
}

// The caller holds only this session's gate. Cleanup of a configured provider
// is retried outside the node-wide gate. A removed provider permits an explicit
// move while permanently retaining its resource tombstones.
func (c *Core) prepareSession(ctx context.Context, pid string, s Session) (Binding, string, bool, error) {
	var b Binding
	var reused, cleanup bool
	err := func() error {
		if err := c.ops.LockContext(ctx); err != nil {
			return err
		}
		defer c.ops.Unlock()
		d := c.store.Snapshot()
		var exists bool
		b, exists = d.Bindings[s.key()]
		if exists && !b.Deleted {
			if _, configured := d.Providers[b.ProviderID]; configured {
				if pid != "" && pid != b.ProviderID {
					return fault("conflict", "session is bound to a different provider")
				}
				b.Created = false
				pid = b.ProviderID
				reused = true
				return nil
			}
			if automaticEnsure(ctx) {
				return fault("unavailable", "session provider was removed; an explicit rebind is required")
			}
			b.Deleted = true
			b.DeletePending = b.ChatID != ""
			if err := c.store.Update(func(d *State) error { recordTombstone(d, b); return nil }); err != nil {
				return err
			}
			d = c.store.Snapshot()
		}
		if exists && b.Deleted && automaticEnsure(ctx) {
			return fault("deleted", "automatic enrollment cannot reactivate a deleted session")
		}
		if pid == "" {
			if _, configured := d.Providers[b.ProviderID]; exists && configured {
				pid = b.ProviderID
			} else {
				pid = d.DefaultProvider
			}
		}
		if _, err := c.provider(pid); err != nil {
			return err
		}
		if exists && b.DeletePending {
			if _, configured := d.Providers[b.ProviderID]; configured {
				cleanup = true
			} else if pid == b.ProviderID {
				return fault("unavailable", "removed provider cannot reactivate its retired resources")
			}
		}
		return nil
	}()
	if err != nil {
		return b, pid, false, err
	}
	if cleanup {
		if err := c.cleanupBinding(ctx, &b); err != nil {
			return b, pid, false, err
		}
	}
	return b, pid, reused, nil
}
func (c *Core) cleanupBinding(ctx context.Context, b *Binding) error {
	lease, err := c.captureProvider(ctx, b.ProviderID, b.Session)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = lease.Bot.Delete(ctx, *b); err != nil {
		return err
	}
	b.DeletePending = false
	c.ops.Lock()
	defer c.ops.Unlock()
	return c.store.Update(func(d *State) error {
		// A provider deletion may have updated the tombstone while cleanup waited.
		// Preserve that newer mapping and update only the resource actually cleaned.
		if current, exists := d.Bindings[b.Session.key()]; exists && current.Deleted && sameResource(current, *b) {
			current.DeletePending = false
			d.Bindings[b.Session.key()] = current
		}
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

// This incarnation component prevents Feishu's create UUID from returning a
// retired group. It remains stable across an uncertain create/restart.
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
