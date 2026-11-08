package main

import (
	"context"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Deletion terminally suppresses queued/retryable events from this activation,
// including on offline downstreams. Explicit ensure permits new messages only.
func recordTombstone(d *State, b Binding) {
	d.Bindings[b.Session.key()] = b
	if b.ChatID != "" {
		if d.RetiredBindings == nil {
			d.RetiredBindings = map[string]Binding{}
		}
		d.RetiredBindings[resourceKey(b)] = b
	}
	for id, record := range d.Events {
		if record.Event.Session.key() == b.Session.key() {
			record.Outcome = "deleted"
			d.Events[id] = record
		}
	}
	log := broadcastLog(d)
	for node, peer := range d.Peers {
		pending := make([]string, 0, len(peer.Pending))
		for _, id := range peer.Pending {
			record, ok := d.Events[id]
			if !ok || record.Outcome != "deleted" {
				pending = append(pending, id)
			}
		}
		peer.Pending = pending
		d.Peers[node] = refillPeer(peer, log)
	}
}

type automaticKey struct{}

func automaticEnsure(ctx context.Context) bool { v, _ := ctx.Value(automaticKey{}).(bool); return v }
func (c *Core) Bind(ctx context.Context, pid string, s Session, chat, sender string) (Binding, error) {
	s = c.normalize(s)
	if err := s.validate(); err != nil {
		return Binding{}, err
	}
	if chat == "" {
		return Binding{}, fault("invalid_argument", "chat_id is required")
	}
	if err := c.ops.LockContext(ctx); err != nil {
		return Binding{}, err
	}
	defer c.ops.Unlock()
	old, selected, reused, err := c.prepareSession(ctx, pid, s)
	if err != nil {
		return old, err
	}
	if reused {
		if chat != old.ChatID {
			return old, fault("conflict", "session already has a different notification binding")
		}
		return old, nil
	}
	pid = selected
	if s.Metadata == nil {
		s.Metadata = old.Session.Metadata
	}
	if s.Name == "" {
		s.Name = old.Session.Name
	}
	d := c.store.Snapshot()
	candidate := Binding{ProviderID: pid, Session: s, ChatID: chat}
	setResourceOrigin(d, &candidate, d.NodeID)
	if wasRetired(d, candidate) {
		return candidate, fault("conflict", "retired notification resources cannot be re-adopted")
	}
	for _, b := range d.Bindings {
		sameProvider := b.ProviderID == pid
		selected := d.Providers[pid]
		other := d.Providers[b.ProviderID]
		if selected.Type == "feishu" && other.Type == "feishu" && selected.AppID == other.AppID {
			sameProvider = true
		}
		if sameProvider && b.ChatID == chat && b.Session.key() != s.key() && !b.Deleted {
			return Binding{}, fault("conflict", "chat is bound to another session")
		}
	}
	provider, err := c.provider(pid)
	if err != nil {
		return Binding{}, err
	}
	binder, ok := provider.(interface {
		Bind(context.Context, Session, string, string) (Binding, error)
	})
	if !ok {
		return Binding{}, fault("unsupported_operation", "provider cannot adopt existing groups")
	}
	b, err := binder.Bind(ctx, s, chat, sender)
	if err != nil {
		return b, err
	}
	b.ProviderID = pid
	setResourceOrigin(d, &b, d.NodeID)
	if wasRetired(d, b) {
		return b, fault("conflict", "retired notification resources cannot be re-adopted")
	}
	if b.Session.key() != s.key() {
		return b, fault("conflict", "provider returned a different session identity")
	}
	b.Deleted = false
	b.DeletePending = false
	err = c.store.Update(func(d *State) error { d.Bindings[s.key()] = b; return nil })
	return b, err
}
func (p *remoteProvider) Bind(ctx context.Context, s Session, chat, sender string) (Binding, error) {
	var b Binding
	err := p.call(ctx, "session.bind", map[string]any{"session": s, "chat_id": chat, "sender_open_id": sender}, &b)
	return b, err
}

var legacyRoutePattern = regexp.MustCompile(`agent-session:v1:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)`)

func verifyLegacyRoutes(raw []byte, s Session) error {
	routes := legacyRoutePattern.FindAllSubmatch(raw, -1)
	host, _ := os.Hostname()
	for _, match := range routes {
		legacyHost, _ := s.Metadata["legacy_host"].(string)
		if string(match[2]) != s.Adapter || string(match[3]) != s.SessionID || (string(match[1]) != s.NodeID && string(match[1]) != host && string(match[1]) != legacyHost) {
			return fault("conflict", "existing group metadata identifies another agent session")
		}
	}
	return nil
}
func (p *feishuProvider) Bind(ctx context.Context, s Session, chat, sender string) (Binding, error) {
	if sender == "" {
		sender = p.config.Recipient
	}
	if sender == "" {
		return Binding{}, fault("invalid_argument", "a trusted sender is required")
	}
	var existing struct {
		Description string `json:"description"`
	}
	if err := p.api(ctx, "GET", "/open-apis/im/v1/chats/"+url.PathEscape(chat), nil, &existing); err != nil {
		return Binding{}, err
	}
	if strings.HasPrefix(existing.Description, "nootify-session:v1:") {
		other, err := parseSessionDescription(existing.Description)
		if err != nil {
			return Binding{}, err
		}
		if other.key() != s.key() {
			return Binding{}, fault("conflict", "existing group metadata identifies another agent session")
		}
		if s.Metadata == nil {
			s.Metadata = other.Metadata
		}
	} else {
		announcement, readErr := p.readAnnouncement(ctx, chat)
		if err := readErr; err != nil {
			return Binding{}, err
		}
		if err := verifyLegacyRoutes(announcement, s); err != nil {
			return Binding{}, err
		} // Preserve the original announcement verbatim; route metadata uses description.
		description := sessionDescription(s)
		if len(description) > 2048 {
			return Binding{}, fault("invalid_argument", "session metadata is too large for a Feishu group")
		}
		if err := p.api(ctx, "PATCH", "/open-apis/im/v1/chats/"+url.PathEscape(chat), map[string]any{"description": description}, nil); err != nil {
			return Binding{}, err
		}
	}
	return Binding{ProviderID: p.config.ID, Session: s, ChatID: chat, SenderID: sender}, nil
}

// RetryDelivery is explicit and only allowed after transport proved the previous
// attempt was never accepted. Pending and uncertain submissions cannot replay.
func (c *Core) RetryDelivery(id string) error {
	var event Event
	err := c.store.Update(func(d *State) error {
		v, ok := d.Deliveries[id]
		if !ok {
			return fault("not_found", "delivery does not exist")
		}
		if v.Status != "retryable" {
			return fault("conflict", "only a proven retryable delivery may be retried")
		}
		record, ok := d.Events[v.EventID]
		if !ok {
			return fault("not_found", "source event is missing")
		}
		b, bound := d.Bindings[record.Event.Session.key()]
		if record.Outcome == "deleted" || (bound && b.Deleted) {
			return fault("deleted", "notification session was deleted")
		}
		v.Status = "pending"
		v.Error = ""
		v.Transport = ""
		d.Deliveries[id] = v
		event = record.Event
		return nil
	})
	if err != nil {
		return err
	}
	if c.emit == nil {
		return c.Complete(id, "unconfirmed", "", "")
	}
	if err = c.emit("delivery", map[string]any{"delivery_id": id, "session": event.Session, "message": event.Message, "content": event.Content, "text": event.Content.Plain(), "sender_id": event.SenderID, "chat_id": event.ChatID}); err != nil {
		_ = c.Complete(id, "unconfirmed", "", "")
		return err
	}
	return nil
}
