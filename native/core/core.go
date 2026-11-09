package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
)

type Core struct {
	store     *Store
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	ops       *operationGate
	sessions  sessionGates
	acks      sessionGates
	providers map[string]Provider
	statuses  map[string]string
	subs      map[string]map[*Subscription]struct{}
	emit      func(string, any) error
	server    *remoteServer
	dialMu    sync.Mutex
	dials     map[string]chan dialResult
}

func NewCore(parent context.Context, s *Store, emit func(string, any) error) (*Core, error) {
	ctx, cancel := context.WithCancel(parent)
	c := &Core{store: s, ctx: ctx, cancel: cancel, ops: newOperationGate(), providers: map[string]Provider{}, statuses: map[string]string{}, subs: map[string]map[*Subscription]struct{}{}, emit: emit, dials: map[string]chan dialResult{}}
	err := s.Update(func(d *State) error {
		// Upgrade deleted bindings written before resource tombstones existed.
		for _, binding := range d.Bindings {
			if binding.Deleted && binding.ChatID != "" {
				setResourceOrigin(*d, &binding, d.NodeID)
				d.RetiredBindings[resourceKey(binding)] = binding
			}
		}
		for id, v := range d.Deliveries {
			if v.Status == "pending" {
				v.Status = "unconfirmed"
				d.Deliveries[id] = v
			}
		}
		return nil
	})
	if err != nil {
		cancel()
		return nil, err
	}
	return c, nil
}
func (c *Core) Start() error {
	d := c.store.Snapshot()
	for _, p := range d.Providers {
		c.startProvider(p)
	}
	if d.Remote.Enabled {
		return c.startServer(d.Remote)
	}
	return nil
}
func (c *Core) Close() {
	c.cancel()
	c.mu.Lock()
	ps := c.providers
	c.providers = map[string]Provider{}
	sv := c.server
	c.server = nil
	for _, streams := range c.subs {
		for s := range streams {
			s.cancel()
		}
	}
	c.mu.Unlock()
	if sv != nil {
		sv.stop()
	}
	for _, p := range ps {
		_ = p.Close()
	}
}
func (c *Core) node() string { return c.store.Snapshot().NodeID }
func (c *Core) normalize(s Session) Session {
	if s.NodeID == "" {
		s.NodeID = c.node()
	}
	return s
}
func (c *Core) log(status, pid, mid string) {
	if c.emit != nil {
		_ = c.emit("log", map[string]any{"status": status, "provider_id": pid, "message_id": mid})
	}
}
func (c *Core) setStatus(id, status string) { c.mu.Lock(); c.statuses[id] = status; c.mu.Unlock() }
func (c *Core) provider(id string) (Provider, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.providers[id]
	if p == nil {
		return nil, fault("unavailable", "provider is disabled, deleted, or unavailable")
	}
	return p, nil
}
func (c *Core) binding(pid string, s Session) (Binding, error) {
	d := c.store.Snapshot()
	b, ok := d.Bindings[s.key()]
	if !ok || b.Deleted {
		return b, fault("not_found", "notification session does not exist")
	}
	if pid != "" && pid != b.ProviderID {
		return b, fault("conflict", "session is bound to a different provider")
	}
	return b, nil
}
func (c *Core) Ensure(ctx context.Context, pid string, s Session) (Binding, error) {
	s = c.normalize(s)
	if err := s.validate(); err != nil {
		return Binding{}, err
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
		return old, nil
	}
	pid = selected
	if s.Metadata == nil {
		s.Metadata = old.Session.Metadata
	}
	if s.Name == "" {
		s.Name = old.Session.Name
	}
	lease, err := c.captureProvider(ctx, pid, s)
	if err != nil {
		return old, err
	}
	if err := ctx.Err(); err != nil {
		return old, err
	}
	b, err := lease.Bot.Ensure(ctx, s)
	if err != nil {
		return b, err
	}
	b.ProviderID = pid
	b.Session = s
	b.Created = true
	b.Deleted = false
	b.DeletePending = false
	return c.publishBinding(lease, b)
}
func (c *Core) GetMetadata(ctx context.Context, pid string, s Session) (map[string]any, error) {
	s = c.normalize(s)
	b, err := c.binding(pid, s)
	if err != nil {
		return nil, err
	}
	p, err := c.provider(b.ProviderID)
	if err != nil {
		return nil, err
	}
	return p.GetMetadata(ctx, b)
}
func (c *Core) SetMetadata(ctx context.Context, pid string, s Session, m map[string]any) (map[string]any, error) {
	s = c.normalize(s)
	unlock, err := c.sessions.acquire(ctx, s.key())
	if err != nil {
		return nil, err
	}
	defer unlock()
	b, err := c.binding(pid, s)
	if err != nil {
		return nil, err
	}
	lease, err := c.captureProvider(ctx, b.ProviderID, s)
	if err != nil {
		return nil, err
	}
	if lease.Binding.Deleted {
		return nil, fault("deleted", "notification session was deleted")
	}
	b = lease.Binding
	v, err := lease.Bot.SetMetadata(ctx, b, m)
	if err != nil {
		return nil, err
	}
	c.ops.Lock()
	defer c.ops.Unlock()
	err = c.store.Update(func(d *State) error {
		if !c.leaseCurrent(*d, lease) || bindingState(*d, s) != lease.BindingState {
			return fault("conflict", "provider or session changed while setting metadata")
		}
		b.Session.Metadata = v
		d.Bindings[s.key()] = b
		return nil
	})
	return v, err
}
func (c *Core) Delete(ctx context.Context, pid string, s Session) error {
	s = c.normalize(s)
	if err := s.validate(); err != nil {
		return err
	}
	unlock, err := c.sessions.acquire(ctx, s.key())
	if err != nil {
		return err
	}
	defer unlock()
	if err := c.ops.LockContext(ctx); err != nil {
		return err
	}
	// Release the configuration gate before any cleanup RPC.
	locked := true
	defer func() {
		if locked {
			c.ops.Unlock()
		}
	}()
	d := c.store.Snapshot()
	b, ok := d.Bindings[s.key()]
	if ok && pid != "" && b.ProviderID != pid {
		return fault("conflict", "session is bound to a different provider")
	}
	if ok && b.Deleted && !b.DeletePending {
		return nil
	}
	if !ok {
		b = Binding{ProviderID: pid, Session: s, Deleted: true}
		return c.store.Update(func(d *State) error { recordTombstone(d, b); return nil })
	}
	b.Deleted = true
	b.DeletePending = b.ChatID != ""
	setResourceOrigin(d, &b, d.NodeID)
	if err := c.store.Update(func(d *State) error { recordTombstone(d, b); return nil }); err != nil {
		return err
	}
	c.ops.Unlock()
	locked = false
	c.wakePeers()
	if !b.DeletePending {
		return nil
	}
	// Removed providers cannot be contacted. The mapping stays tombstoned and
	// retired; explicit Ensure/Bind may select an available replacement.
	if _, configured := d.Providers[b.ProviderID]; !configured {
		return nil
	}
	return c.cleanupBinding(ctx, &b)
}
func (c *Core) operation(ctx context.Context, key, request string, input any, automatic bool, fn func(string) (SendResult, error)) (SendResult, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return SendResult{}, err
	}
	hash := sha256.Sum256(raw)
	finger := hex.EncodeToString(hash[:])
	if automatic {
		key = "auto-send:" + finger
	}
	request, cached, err := c.admitOperation(ctx, key, request, finger, automatic)
	if err != nil {
		return SendResult{}, err
	}
	if cached != nil {
		return *cached, nil
	}
	// Cancellation while fsyncing is a proven pre-submission failure.
	if err = ctx.Err(); err != nil {
		rejection := rejectOperation(true, "request expired before provider submission")
		if key != "" {
			if persistErr := c.store.Update(func(d *State) error {
				op := d.Operations[key]
				op.State = "retryable"
				op.Failure = publicError(rejection)
				d.Operations[key] = op
				return nil
			}); persistErr != nil {
				return SendResult{}, persistErr
			}
		}
		return SendResult{}, rejection
	}
	result, err := fn(request)
	if err != nil {
		state, proven := rejectionState(err)
		responseErr := err
		if !proven {
			state = "unconfirmed"
			responseErr = fault("unconfirmed", "provider outcome is unknown; do not automatically resubmit this request")
		}
		if key != "" {
			if persistErr := c.store.Update(func(d *State) error {
				op := d.Operations[key]
				op.State = state
				op.Failure = publicError(responseErr)
				d.Operations[key] = op
				return nil
			}); persistErr != nil {
				return result, persistErr
			}
		}
		return result, responseErr
	}
	err = c.store.Update(func(d *State) error {
		remember(d, result.Message, "")
		if key != "" {
			raw, e := json.Marshal(result)
			if e != nil {
				return e
			}
			d.Operations[key] = Operation{State: "complete", Fingerprint: finger, RequestID: request, Result: raw}
		}
		return nil
	})
	return result, err
}
func (c *Core) Send(ctx context.Context, pid string, s Session, content Content, request string) (SendResult, error) {
	s = c.normalize(s)
	if err := content.Validate(); err != nil {
		return SendResult{}, err
	}
	unlock, err := c.sessions.acquire(ctx, s.key())
	if err != nil {
		return SendResult{}, err
	}
	defer unlock()
	b, err := c.binding(pid, s)
	if err != nil {
		return SendResult{}, err
	}
	if _, err := c.provider(b.ProviderID); err != nil {
		return SendResult{}, err
	}
	key := ""
	if request != "" {
		key = "send:" + s.key() + ":" + request
	}
	return c.operation(ctx, key, request, []any{b.ProviderID, s.key(), content}, request == "", func(effectiveRequest string) (SendResult, error) {
		live, err := c.binding(b.ProviderID, s)
		if err != nil {
			return SendResult{}, rejectOperation(false, "notification binding changed before submission")
		}
		if live.ChatID != b.ChatID {
			return SendResult{}, rejectOperation(false, "notification resource changed before submission")
		}
		lease, err := c.captureProvider(ctx, live.ProviderID, s)
		if err != nil {
			return SendResult{}, rejectOperation(true, "provider is unavailable before submission")
		}
		if lease.Binding.Deleted || lease.Binding.ChatID != live.ChatID {
			return SendResult{}, rejectOperation(false, "notification resource changed before submission")
		}
		if err := ctx.Err(); err != nil {
			return SendResult{}, rejectOperation(true, "request expired before provider submission")
		}
		return lease.Bot.Send(ctx, lease.Binding, content, effectiveRequest)
	})
}
func remember(d *State, m MessageRef, route string) {
	k := m.key()
	r := d.References[k]
	// Older peers and acknowledgment callers may omit optional return context.
	// Once retained, it must survive those references to the same message.
	if r.Message.ThreadID != "" {
		m.ThreadID = r.Message.ThreadID
	}
	r.Message = m
	if route != "" && !contains(r.Routes, route) {
		r.Routes = append(r.Routes, route)
	}
	d.References[k] = r
}
func (c *Core) Resolve(m *MessageRef, id string) (MessageRef, error) {
	if m != nil {
		if !m.valid() {
			return MessageRef{}, fault("invalid_argument", "full message reference is required")
		}
		resolved := *m
		if retained := c.store.Snapshot().References[m.key()].Message; retained.ThreadID != "" {
			resolved.ThreadID = retained.ThreadID
		}
		return resolved, nil
	}
	var found *MessageRef
	for _, v := range c.store.Snapshot().References {
		if v.Message.MessageID == id {
			if found != nil && found.key() != v.Message.key() {
				return MessageRef{}, fault("ambiguous_message", "message ID exists on multiple providers; use the full reference")
			}
			cp := v.Message
			found = &cp
		}
	}
	if found == nil {
		return MessageRef{}, fault("not_found", "message reference is not retained")
	}
	return *found, nil
}
func (c *Core) returnProvider(m MessageRef) (Provider, error) {
	if m.OriginNodeID == c.node() {
		return c.provider(m.ProviderID)
	}
	r, ok := c.store.Snapshot().References[m.key()]
	if !ok {
		return nil, fault("not_found", "message return route is not retained")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var fallback Provider
	for _, id := range r.Routes {
		p := c.providers[id]
		if p == nil {
			continue
		}
		// A remote object survives disconnection; connected means its
		// subscription completed a handshake. Select once before submission:
		// a failed RPC may already have delivered the reply.
		if c.statuses[id] == "connected" {
			return p, nil
		}
		if fallback == nil {
			fallback = p
		}
	}
	if fallback != nil {
		return fallback, nil
	}
	return nil, fault("unavailable", "message return route is unavailable")
}
func (c *Core) Reply(ctx context.Context, m MessageRef, content Content, request string) (SendResult, error) {
	m, err := c.Resolve(&m, "")
	if err != nil {
		return SendResult{}, err
	}
	if err := content.Validate(); err != nil {
		return SendResult{}, err
	}
	p, err := c.returnProvider(m)
	if err != nil {
		return SendResult{}, err
	}
	key := ""
	if request != "" {
		key = "reply:" + m.key() + ":" + request
	}
	return c.operation(ctx, key, request, []any{m, content}, false, func(effectiveRequest string) (SendResult, error) { return p.Reply(ctx, m, content, effectiveRequest) })
}
func (c *Core) Ack(ctx context.Context, m MessageRef) (map[string]any, error) {
	if !m.valid() {
		return nil, fault("invalid_argument", "full message reference is required")
	}
	unlock, err := c.acks.acquire(ctx, m.key())
	if err != nil {
		return nil, err
	}
	defer unlock()
	r := c.store.Snapshot().References[m.key()]
	at := r.AcknowledgedAt
	if at == "" {
		p, err := c.returnProvider(m)
		if err != nil {
			return nil, err
		}
		if err = p.Ack(ctx, m); err != nil {
			return nil, err
		}
		at = now()
		err = c.store.Update(func(d *State) error {
			remember(d, m, "")
			r := d.References[m.key()]
			r.AcknowledgedAt = at
			d.References[m.key()] = r
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{"status": "session_acknowledged", "message_id": m.MessageID, "acknowledged_at": at}, nil
}
func (c *Core) Ingest(ctx context.Context, e Event, route string) error {
	if e.ID == "" || !e.Message.valid() {
		return fault("invalid_argument", "invalid event identity")
	}
	if err := e.Session.validate(); err != nil {
		return err
	}
	if err := e.Content.Validate(); err != nil {
		return err
	}
	if len(e.Visited) > 16 || e.Hops > 16 {
		return fault("invalid_argument", "invalid event route")
	}
	node := c.node()
	// A suppressed copy proves no return path. It must neither retain a route
	// nor reserve the stable ID needed by a later valid, shorter path.
	if contains(e.Visited, node) || e.Hops == 0 {
		return nil
	}
	unlock, err := c.sessions.acquire(ctx, e.Session.key())
	if err != nil {
		return err
	}
	defer unlock()
	var delivery *Delivery
	var wake []string
	err = c.store.Update(func(d *State) error {
		remember(d, e.Message, route)
		if record, ok := d.Events[e.ID]; ok && record.Outcome != "loop_suppressed" {
			if binding, bound := d.Bindings[record.Event.Session.key()]; bound && binding.Deleted {
				return nil
			}
			if record.Outcome == "local" {
				for id, v := range d.Deliveries {
					if v.EventID == e.ID && v.Status == "retryable" {
						v.Status = "pending"
						v.Error = ""
						v.Transport = ""
						d.Deliveries[id] = v
						delivery = &v
						e = record.Event
						break
					}
				}
			}
			return nil
		}
		e.Visited = append(append([]string{}, e.Visited...), node)
		e.Hops--
		record := EventRecord{Event: e}
		b, bound := d.Bindings[e.Session.key()]
		if bound && b.Deleted || retiredResource(d, e) {
			record.Outcome = "deleted"
		} else if e.Session.NodeID == node {
			record.Outcome = "local"
			v := Delivery{ID: uid(), EventID: e.ID, Status: "pending"}
			d.Deliveries[v.ID] = v
			delivery = &v
		} else {
			record.Outcome = "broadcast"
			d.BroadcastSequence++
			record.Sequence = d.BroadcastSequence
			d.Events[e.ID] = record
			log := broadcastLog(d)
			for id, p := range d.Peers {
				d.Peers[id] = refillPeer(p, log)
				wake = append(wake, id)
			}
		}
		d.Events[e.ID] = record
		return nil
	})
	if err != nil {
		return err
	}
	for _, id := range wake {
		c.wake(id)
	}
	if delivery != nil {
		data := map[string]any{"delivery_id": delivery.ID, "session": e.Session, "message": e.Message, "content": e.Content, "text": e.Content.Plain(), "sender_id": e.SenderID, "chat_id": e.ChatID}
		if c.emit == nil || c.emit("delivery", data) != nil {
			_ = c.Complete(delivery.ID, "unconfirmed", "", "")
		}
	}
	return nil
}
func (c *Core) Complete(id, status, transport, msg string) error {
	switch status {
	case "delivered", "retryable", "unconfirmed", "rejected":
	default:
		return fault("invalid_argument", "invalid delivery status")
	}
	return c.store.Update(func(d *State) error {
		v, ok := d.Deliveries[id]
		if !ok {
			return fault("not_found", "delivery does not exist")
		}
		if v.Status != "pending" && v.Status != status {
			return fault("conflict", "delivery already completed")
		}
		v.Status = status
		v.Transport = transport
		v.Error = msg
		d.Deliveries[id] = v
		return nil
	})
}

type Subscription struct {
	core    *Core
	node    string
	ctx     context.Context
	cancel  context.CancelFunc
	signal  chan struct{}
	mu      sync.Mutex
	offered map[string]bool
}

func (c *Core) Subscribe(ctx context.Context, node, name string) (*Subscription, error) {
	if node == "" || node == c.node() || len(node) > 128 || len(name) > 256 {
		return nil, fault("invalid_argument", "invalid subscriber identity")
	}
	if err := c.store.Update(func(d *State) error {
		p, exists := d.Peers[node]
		if !exists {
			p.Cursor = d.BroadcastSequence
		}
		p.NodeID = node
		p.Name = name
		p.ConnectedAt = now()
		if p.Pending == nil {
			p.Pending = []string{}
		}
		d.Peers[node] = refillPeer(p, broadcastLog(d))
		return nil
	}); err != nil {
		return nil, err
	}
	sctx, cancel := context.WithCancel(ctx)
	s := &Subscription{core: c, node: node, ctx: sctx, cancel: cancel, signal: make(chan struct{}, 1), offered: map[string]bool{}}
	c.mu.Lock()
	if c.subs[node] == nil {
		c.subs[node] = map[*Subscription]struct{}{}
	}
	c.subs[node][s] = struct{}{}
	c.mu.Unlock()
	return s, nil
}
func (c *Core) wake(node string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for s := range c.subs[node] {
		select {
		case s.signal <- struct{}{}:
		default:
		}
	}
}
func (s *Subscription) Next() (Event, error) {
	for {
		if err := s.ctx.Err(); err != nil {
			return Event{}, err
		}
		s.mu.Lock()
		d := s.core.store.Snapshot()
		p := d.Peers[s.node]
		pendingSet := make(map[string]bool, len(p.Pending))
		for _, id := range p.Pending {
			pendingSet[id] = true
		}
		for id := range s.offered {
			if !pendingSet[id] {
				delete(s.offered, id)
			}
		}
		for _, id := range p.Pending {
			if !s.offered[id] {
				r, ok := d.Events[id]
				if !ok {
					s.mu.Unlock()
					return Event{}, fmt.Errorf("pending event is missing")
				}
				s.offered[id] = true
				s.mu.Unlock()
				return r.Event, nil
			}
		}
		s.mu.Unlock()
		select {
		case <-s.ctx.Done():
			return Event{}, s.ctx.Err()
		case <-s.signal:
		}
	}
}
func (s *Subscription) Confirm(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.core.store.Update(func(d *State) error {
		p, ok := d.Peers[s.node]
		if !ok {
			return fault("not_found", "subscriber does not exist")
		}
		for i, v := range p.Pending {
			if v == id {
				p.Pending = append(p.Pending[:i:i], p.Pending[i+1:]...)
				p.LastAck = now()
				d.Peers[s.node] = refillPeer(p, broadcastLog(d))
				return nil
			}
		}
		return nil
	})
	if err == nil {
		delete(s.offered, id)
		s.core.wake(s.node)
	}
	return err
}
func (s *Subscription) Close() {
	s.cancel()
	s.core.mu.Lock()
	streams := s.core.subs[s.node]
	delete(streams, s)
	if len(streams) == 0 {
		delete(s.core.subs, s.node)
	}
	s.core.mu.Unlock()
}
func (c *Core) Status() map[string]any {
	d := c.store.Snapshot()
	ps := []ProviderSummary{}
	c.mu.Lock()
	for _, p := range d.Providers {
		ps = append(ps, summary(p, c.statuses[p.ID]))
	}
	remoteStatus := "disabled"
	if c.server != nil {
		remoteStatus = "listening"
	} else if d.Remote.Enabled {
		remoteStatus = "failed"
	}
	c.mu.Unlock()
	sort.Slice(ps, func(i, j int) bool { return ps[i].ID < ps[j].ID })
	r := remoteSummary(d, remoteStatus)
	c.mu.Lock()
	for i := range r.Peers {
		for sub := range c.subs[r.Peers[i].NodeID] {
			if sub.ctx.Err() == nil {
				r.Peers[i].Connected = true
				break
			}
		}
	}
	c.mu.Unlock()
	return map[string]any{"node_id": d.NodeID, "providers": ps, "default_provider_id": d.DefaultProvider, "remote": r}
}
func summary(p ProviderConfig, status string) ProviderSummary {
	if status == "" {
		if p.Enabled {
			status = "starting"
		} else {
			status = "disabled"
		}
	}
	return ProviderSummary{ID: p.ID, Name: p.Name, Type: p.Type, Enabled: p.Enabled, Status: status, AppID: p.AppID, Recipient: p.Recipient, Address: p.Address, TLS: p.TLS, ServerName: p.ServerName, SecretSet: p.AppSecret != "", TokenSet: p.Token != ""}
}
func remoteSummary(d State, status string) RemoteSummary {
	r := RemoteSummary{Enabled: d.Remote.Enabled, Listen: d.Remote.Listen, Status: status, TLS: d.Remote.CertFile != "", TokenSet: d.Remote.Token != "", CertFile: d.Remote.CertFile, KeyFile: d.Remote.KeyFile, Peers: []PeerSummary{}}
	log := broadcastLog(&d)
	for _, p := range d.Peers {
		r.Peers = append(r.Peers, PeerSummary{NodeID: p.NodeID, Name: p.Name, ConnectedAt: p.ConnectedAt, Pending: pendingCount(p, log), LastAck: p.LastAck, PublicKey: p.PublicKey, IdentityStatus: peerIdentityStatus(p)})
	}
	sort.Slice(r.Peers, func(i, j int) bool { return r.Peers[i].NodeID < r.Peers[j].NodeID })
	return r
}

var _ Router = (*Core)(nil)
