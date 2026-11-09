package main

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
)

// Deletion terminally suppresses queued/retryable events from this activation,
// including on offline downstreams. Explicit ensure permits new messages only.
func recordTombstone(d *State, b Binding) {
	d.Bindings[b.Session.key()] = b
	if d.RetiredBindings == nil {
		d.RetiredBindings = map[string]Binding{}
	}
	for _, resource := range bindingResources(b) {
		if resource.ChatID != "" {
			resource.Deleted = true
			resource.DeletePending = b.DeletePending
			d.RetiredBindings[resourceKey(resource)] = resource
		}
	}
	for id, record := range d.Events {
		if record.Event.Session.key() == b.Session.key() {
			if record.Event.ChatID != "" {
				resource := Binding{Session: record.Event.Session, ProviderID: b.ProviderID, ChatID: record.Event.ChatID, ResourceNodeID: record.Event.Message.OriginNodeID, ResourceProviderID: record.Event.Message.ProviderID, Deleted: true}
				d.RetiredBindings[resourceKey(resource)] = resource
			}
			cancelEvent(d, id)
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
	unlock, err := c.sessions.acquire(ctx, s.key())
	if err != nil {
		return Binding{}, err
	}
	defer unlock()
	old, selected, reused, err := c.prepareSession(ctx, pid, s)
	if err != nil {
		return old, err
	}
	if reused {
		for _, resource := range bindingResources(old) {
			if resource.ChatID != chat {
				continue
			}
			if sender != "" && sender != resource.SenderID {
				return old, fault("conflict", "session already has a different trusted sender")
			}
			provider, err := c.provider(resource.ProviderID)
			if err != nil {
				return old, err
			}
			if validator, ok := provider.(interface {
				ValidateBinding(context.Context, Binding) error
			}); ok {
				if err := validator.ValidateBinding(ctx, resource); err != nil {
					return old, err
				}
			}
			resource.Created = false
			return resource, nil
		}
		return old, fault("conflict", "session already has a different notification binding")
	}
	pid = selected
	resourceUnlock, err := c.sessions.acquire(ctx, "resource:"+chat)
	if err != nil {
		return Binding{}, err
	}
	defer resourceUnlock()
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
	for _, binding := range d.Bindings {
		for _, b := range bindingResources(binding) {
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
	}
	lease, err := c.captureProvider(ctx, pid, s)
	if err != nil {
		return Binding{}, err
	}
	binder, ok := lease.Bot.(interface {
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
	return c.publishBinding(lease, b)
}
func (p *remoteProvider) Bind(ctx context.Context, s Session, chat, sender string) (Binding, error) {
	var b Binding
	err := p.call(ctx, "session.bind", map[string]any{"session": s, "chat_id": chat, "sender_open_id": sender}, &b)
	return b, err
}

// JavaScript's retained parser accepts Unicode whitespace as well as ASCII.
const legacyWhitespace = `[\s\v\p{Zs}\x{2028}\x{2029}\x{FEFF}]`

var (
	legacyRoutePattern    = regexp.MustCompile(`agent-session:v1:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)`)
	legacyDesktopPattern  = regexp.MustCompile(`(?i)\blocal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b`)
	legacyCodexPattern    = regexp.MustCompile(`(?i)\bCodex` + legacyWhitespace + `*(?:thread|session|会话)?` + legacyWhitespace + `*[:：]?` + legacyWhitespace + `*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b`)
	legacyOpenCodePattern = regexp.MustCompile(`(?i)\bOpen` + legacyWhitespace + `?Code` + legacyWhitespace + `*(?:thread|session|会话)?` + legacyWhitespace + `*[:：]?` + legacyWhitespace + `*(ses_[A-Za-z0-9]+)\b`)
)

func verifyLegacyRoutes(raw []byte, s Session) error {
	var content any
	if err := json.Unmarshal(raw, &content); err != nil {
		return fault("unavailable", "invalid announcement content")
	}
	// Mirror the retained TypeScript parser: explicit markers, Desktop IDs,
	// labeled Codex UUIDs and labeled OpenCode IDs all declare routes. A label
	// repeating an explicit identity adds no ambiguity, but distinct declarations
	// (including different explicit hosts) must not be silently overwritten.
	type route struct{ host, adapter, session string }
	routes := map[route]bool{}
	text := announcementText(content)
	for _, match := range legacyRoutePattern.FindAllStringSubmatch(text, -1) {
		routes[route{match[1], match[2], match[3]}] = true
	}
	declared := func(adapter, session string) bool {
		for r := range routes {
			if r.session == session && (adapter == "" || r.adapter == adapter) {
				return true
			}
		}
		return false
	}
	for _, id := range legacyDesktopPattern.FindAllString(text, -1) {
		if !declared("", id) {
			routes[route{"", "claude-desktop", id}] = true
		}
	}
	for _, label := range []struct {
		adapter string
		pattern *regexp.Regexp
	}{{"codex", legacyCodexPattern}, {"opencode", legacyOpenCodePattern}} {
		for _, match := range label.pattern.FindAllStringSubmatch(text, -1) {
			if !declared(label.adapter, match[1]) {
				routes[route{"", label.adapter, match[1]}] = true
			}
		}
	}
	if len(routes) > 1 {
		return fault("conflict", "existing group metadata declares multiple agent sessions")
	}
	host, _ := os.Hostname()
	legacyHost, _ := s.Metadata["legacy_host"].(string)
	for r := range routes {
		if r.adapter != s.Adapter || r.session != s.SessionID || (r.host != "" && r.host != s.NodeID && r.host != host && r.host != legacyHost) {
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
	evidence := &sourceTimeEvidence{}
	validated, err := p.validateGroup(context.WithValue(ctx, sourceTimeEvidenceKey{}, evidence), s, chat)
	if err != nil {
		return Binding{}, err
	}
	// Routing authority is retained transactionally in the binding. Existing
	// descriptions and announcements remain untouched, including if persistence
	// later fails or the provider/session changes while adoption is in flight.
	if evidence.source <= sourceTimeOverlap {
		return Binding{}, fault("unavailable", "fresh Feishu source clock is required to adopt an existing group")
	}
	start := evidence.source - sourceTimeOverlap
	b := Binding{ProviderID: p.config.ID, Session: validated, ChatID: chat, SenderID: sender, PreserveDescription: true, HistoryStart: start}
	retainLegacyIdentity(&b)
	return b, nil
}

// RetryDelivery is explicit and only allowed after transport proved the previous
// attempt was never accepted. Pending and uncertain submissions cannot replay.
func (c *Core) RetryDelivery(id string) error { return c.RetryDeliveryContext(c.ctx, id) }

func (c *Core) RetryDeliveryContext(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := c.store.FlushUndispatched(); err != nil {
		return err
	}
	d := c.store.Snapshot()
	v, ok := d.Deliveries[id]
	if !ok {
		return fault("not_found", "delivery does not exist")
	}
	record, ok := d.Events[v.EventID]
	if !ok {
		return fault("not_found", "source event is missing")
	}
	// Keep the deletion gate through dispatch, not just the durable pending
	// transition. Once Delete completes, no queued retry can reach the adapter.
	unlock, err := c.sessions.acquire(ctx, record.Event.Session.key())
	if err != nil {
		return err
	}
	defer unlock()
	return c.dispatchDelivery(ctx, id)
}
