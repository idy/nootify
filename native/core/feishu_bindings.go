package main

import (
	"context"
	"net/url"
	"strings"
)

// Each retained resource has the same business session but independent trust and
// source identity. Aliases are imported leaves, never a second session mapping.
func bindingResources(b Binding) []Binding {
	aliases := b.Aliases
	b.Aliases = nil
	resources := []Binding{b}
	for _, alias := range aliases {
		alias.Aliases = nil
		alias.Deleted = alias.Deleted || b.Deleted
		resources = append(resources, alias)
	}
	return resources
}

func legacyBinding(b Binding) bool {
	_, migrated := b.Session.Metadata["legacy_host"]
	return b.Legacy || b.PreserveDescription || migrated
}

func retainLegacyIdentity(b *Binding) {
	if legacyBinding(*b) {
		b.Legacy = true
		b.PreserveDescription = true
		if b.LegacyHost == "" {
			b.LegacyHost, _ = b.Session.Metadata["legacy_host"].(string)
		}
	}
}

func (p *feishuProvider) validateGroup(ctx context.Context, s Session, chat string) (Session, error) {
	var existing struct {
		Description string `json:"description"`
	}
	if err := p.api(ctx, "GET", "/open-apis/im/v1/chats/"+url.PathEscape(chat), nil, &existing); err != nil {
		return s, err
	}
	if strings.HasPrefix(existing.Description, "nootify-session:v1:") {
		other, err := parseSessionDescription(existing.Description)
		if err != nil {
			return s, err
		}
		if other.key() != s.key() {
			return s, fault("conflict", "existing group metadata identifies another agent session")
		}
		if s.Metadata == nil {
			s.Metadata = other.Metadata
		}
	}
	// A managed description never overrides a conflicting human announcement.
	announcement, err := p.readAnnouncement(ctx, chat)
	if err != nil {
		return s, err
	}
	return s, verifyLegacyRoutes(announcement, s)
}

func (p *feishuProvider) ValidateBinding(ctx context.Context, b Binding) error {
	s := b.Session
	if b.LegacyHost != "" {
		metadata := map[string]any{}
		for k, v := range s.Metadata {
			metadata[k] = v
		}
		metadata["legacy_host"] = b.LegacyHost
		s.Metadata = metadata
	}
	_, err := p.validateGroup(ctx, s, b.ChatID)
	return err
}

func (p *feishuProvider) incomingBinding(chat, sender string) (Binding, bool) {
	d := p.core.store.Snapshot()
	for _, binding := range d.Bindings {
		for _, b := range bindingResources(binding) {
			cfg, ok := d.Providers[b.ProviderID]
			if !ok || cfg.Type != "feishu" || cfg.AppID != p.config.AppID || b.ChatID != chat || b.Deleted {
				continue
			}
			trusted := b.SenderID
			if trusted == "" {
				trusted = cfg.Recipient
			}
			if trusted != "" && trusted == sender {
				return b, true
			}
		}
	}
	return Binding{}, false
}

func retireProviderResources(d *State, id string) {
	for key, binding := range d.Bindings {
		if binding.ProviderID == id {
			setResourceOrigin(*d, &binding, d.NodeID)
			binding.Deleted = true
			binding.DeletePending = binding.ChatID != ""
			recordTombstone(d, binding)
			continue
		}
		for i, alias := range binding.Aliases {
			if alias.ProviderID != id {
				continue
			}
			setResourceOrigin(*d, &alias, d.NodeID)
			alias.Deleted, alias.DeletePending = true, alias.ChatID != ""
			binding.Aliases[i] = alias
			d.RetiredBindings[resourceKey(alias)] = alias
		}
		d.Bindings[key] = binding
	}
	for key, event := range d.Events {
		if retiredResource(d, event.Event) {
			cancelEvent(d, key)
		}
	}
	log := broadcastLog(d)
	for node, peer := range d.Peers {
		pending := make([]string, 0, len(peer.Pending))
		for _, eventID := range peer.Pending {
			if d.Events[eventID].Outcome != "deleted" {
				pending = append(pending, eventID)
			}
		}
		peer.Pending = pending
		d.Peers[node] = refillPeer(peer, log)
	}
}
