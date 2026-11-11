package core

import (
	"context"
	"encoding/json"
	"sort"
	"time"
)

func polledInbox(adapter string) bool { return adapter == "trae" || adapter == "workbuddy" }
func inboxReferenceHeld(r ReferenceRecord) bool {
	return r.InboxState != "" && r.InboxState != "consumed"
}
func inboxTimestamp(d *State) int64 {
	if d.Retention.at != 0 {
		return d.Retention.at / int64(time.Millisecond)
	}
	return time.Now().UnixMilli()
}
func nextInboxStamp(d *State, previous int64) int64 {
	stamp := inboxTimestamp(d)
	if stamp <= previous {
		stamp = previous + 1
	}
	return stamp
}

// Every hop observes the polled destination before confirming durable ingest.
// Preserve the event ID and its exact return routes until the destination has
// consumed it, including when intermediate peers have already confirmed it.
func holdInbox(d *State, e Event, route string) {
	if !polledInbox(e.Session.Adapter) {
		return
	}
	record, exists := d.Events[e.ID]
	if exists && record.Outcome != "local" && record.Outcome != "broadcast" {
		return
	}
	if binding, bound := d.Bindings[e.Session.key()]; bound && binding.Deleted || retiredResource(d, e) {
		return
	}
	key := e.Message.key()
	r := d.References[key]
	if r.InboxState == "" || !exists && r.InboxState == "consumed" {
		r.InboxState, r.InboxNodeID = "pending", e.Session.NodeID
		r.InboxUpdatedAt = nextInboxStamp(d, r.InboxUpdatedAt)
		r.InboxReleasedRoutes = nil
	} else if r.InboxState == "consumed" && route != "" && !contains(r.InboxReleasedRoutes, route) {
		// A deduplicated late copy can introduce another upstream branch. It
		// must be released too, without submitting the agent input again.
		r.InboxState = "releasing"
		r.InboxUpdatedAt = nextInboxStamp(d, r.InboxUpdatedAt)
	}
	d.References[key] = r
}

type inboxReleaser interface {
	ReleaseInbox(context.Context, MessageRef) error
}
type inboxConsumptionReader interface {
	InboxConsumed(context.Context, MessageRef) (bool, error)
}

// InboxConsumed propagates completion to broadcast siblings that are not on
// the actual consumer's return path. Pending holds are durably admitted at the
// origin before a polled event is published and cannot expire; an absent
// origin record therefore represents completed history beyond its horizon.
// Transit nodes proxy to that authority instead of guessing from peer acks.
func (c *Core) InboxConsumed(ctx context.Context, m MessageRef) (bool, error) {
	if !m.valid() {
		return false, fault("invalid_argument", "full message reference is required")
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	d := c.store.Snapshot()
	r, exists := d.References[m.key()]
	if !exists || r.InboxState == "consumed" {
		return true, nil
	}
	if m.OriginNodeID == d.NodeID {
		return false, nil
	}
	var first error
	var pending bool
	for _, route := range r.Routes {
		provider, err := c.provider(route)
		if err == nil {
			reader, ok := provider.(inboxConsumptionReader)
			if !ok {
				err = fault("unavailable", "message return provider cannot query inbox consumption")
			} else {
				var consumed bool
				consumed, err = reader.InboxConsumed(ctx, r.Message)
				if err == nil {
					if consumed {
						return true, nil
					}
					pending = true
				}
			}
		}
		if err != nil && first == nil {
			first = err
		}
	}
	if pending {
		return false, nil
	}
	if first != nil {
		return false, first
	}
	return false, fault("unavailable", "inbox consumption authority is unavailable")
}

// ReleaseInbox records an idempotent release intent before attempting any RPC.
// Progress is persisted per upstream route, never just the preferred reply
// route. Offline routes remain pinned and are retried by startInboxReleases.
func (c *Core) ReleaseInbox(ctx context.Context, m MessageRef) error {
	if !m.valid() {
		return fault("invalid_argument", "full message reference is required")
	}
	ctx, cancel := context.WithTimeout(ctx, inboxSweepBudget)
	defer cancel()
	unlock, err := c.inboxReleases.acquire(ctx, m.key())
	if err != nil {
		return err
	}
	defer unlock()
	var generation int64
	err = c.store.Update(func(d *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		r, exists := d.References[m.key()]
		if !exists || r.InboxState == "" {
			return nil // An already reclaimed completed release is idempotent.
		}
		if r.InboxState != "releasing" {
			if r.InboxState == "consumed" && allInboxRoutesReleased(*d, r) {
				return nil
			}
			r.InboxState = "releasing"
			r.InboxUpdatedAt = nextInboxStamp(d, r.InboxUpdatedAt)
			d.References[m.key()] = r
		}
		generation = r.InboxUpdatedAt
		return nil
	})
	if err != nil || generation == 0 {
		return err
	}
	r := c.store.Snapshot().References[m.key()]
	var first error
	if m.OriginNodeID != c.node() {
		routes := make([]string, 0, len(r.Routes))
		for _, route := range r.Routes {
			if !contains(r.InboxReleasedRoutes, route) {
				routes = append(routes, route)
			}
		}
		sort.Strings(routes)
		start := sort.Search(len(routes), func(i int) bool { return routes[i] > r.InboxReleaseCursor })
		routes = append(append([]string{}, routes[start:]...), routes[:start]...)
		for attempt, route := range routes {
			if attempt >= inboxSweepBatch || ctx.Err() != nil {
				break
			}
			// Persist rotation before I/O: even a crash during a hanging first
			// branch lets the next process start with a different branch.
			releaseErr := c.store.Update(func(d *State) error {
				if err := ctx.Err(); err != nil {
					return err
				}
				current := d.References[m.key()]
				if current.InboxState != "releasing" || current.InboxUpdatedAt != generation {
					return fault("conflict", "inbox obligation changed during release")
				}
				current.InboxReleaseCursor = route
				d.References[m.key()] = current
				return nil
			})
			if releaseErr != nil {
				if first == nil {
					first = releaseErr
				}
				break
			}
			provider, releaseErr := c.provider(route)
			if releaseErr == nil {
				releaser, ok := provider.(inboxReleaser)
				if !ok {
					releaseErr = fault("unavailable", "message return provider cannot release an inbox hold")
				} else {
					request, cancel := context.WithTimeout(ctx, inboxRouteAttemptBudget)
					releaseErr = releaser.ReleaseInbox(request, r.Message)
					cancel()
				}
			}
			if releaseErr == nil {
				releaseErr = c.store.Update(func(d *State) error {
					if err := ctx.Err(); err != nil {
						return err
					}
					current := d.References[m.key()]
					if current.InboxState != "releasing" || current.InboxUpdatedAt != generation {
						return fault("conflict", "inbox obligation changed during release")
					}
					if !contains(current.InboxReleasedRoutes, route) {
						current.InboxReleasedRoutes = append(current.InboxReleasedRoutes, route)
					}
					d.References[m.key()] = current
					return nil
				})
			}
			if releaseErr != nil && first == nil {
				first = releaseErr
			}
		}
	}
	if first != nil {
		return first
	}
	return c.store.Update(func(d *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		current := d.References[m.key()]
		if current.InboxState != "releasing" || current.InboxUpdatedAt != generation {
			return fault("conflict", "inbox obligation changed during release")
		}
		if !allInboxRoutesReleased(*d, current) {
			return fault("unavailable", "an additional inbox return route still needs release")
		}
		current.InboxState = "consumed"
		current.InboxUpdatedAt = nextInboxStamp(d, current.InboxUpdatedAt)
		d.References[m.key()] = current
		retainReference(d, m.key()) // Full return/receipt horizon after consumption.
		return nil
	})
}

func allInboxRoutesReleased(d State, r ReferenceRecord) bool {
	if r.Message.OriginNodeID == d.NodeID {
		return true
	}
	for _, route := range r.Routes {
		if !contains(r.InboxReleasedRoutes, route) {
			return false
		}
	}
	// A remote message with no known route has not proved upstream release.
	return len(r.Routes) != 0
}

func markInboxConsumed(d *State, m MessageRef) {
	for id, delivery := range d.Deliveries {
		event, exists := d.Events[delivery.EventID]
		if exists && event.Event.Session.NodeID == d.NodeID && polledInbox(event.Event.Session.Adapter) && event.Event.Message.key() == m.key() && delivery.Status != "rejected" {
			// Node's durable consumption also proves queue acceptance when its
			// earlier completion RPC was lost or is still in flight. Otherwise
			// a crash here would strand a pending/unconfirmed delivery forever.
			delivery.Status, delivery.Transport = "delivered", "inbox_consumed"
			d.Deliveries[id] = delivery
		}
	}
	r, exists := d.References[m.key()]
	if exists && r.InboxState != "consumed" && r.InboxState != "releasing" {
		r.InboxState = "releasing"
		r.InboxUpdatedAt = nextInboxStamp(d, r.InboxUpdatedAt)
		d.References[m.key()] = r
	}
}

// ConsumeInbox is private to Node's durable inbox acknowledgment/reconciliation.
// Its persisted release intent survives an offline upstream or a service crash.
func (c *Core) ConsumeInbox(ctx context.Context, m MessageRef) error {
	if !m.valid() {
		return fault("invalid_argument", "full message reference is required")
	}
	err := c.store.Update(func(d *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if r := d.References[m.key()]; r.InboxNodeID != "" && r.InboxNodeID != d.NodeID {
			return fault("permission_denied", "inbox belongs to another node")
		}
		markInboxConsumed(d, m)
		acknowledgeCanceledInbox(d, m.key())
		return nil
	})
	if err != nil {
		return err
	}
	return c.ReleaseInbox(ctx, m)
}

func acknowledgeCanceledInbox(d *State, key string) {
	r, exists := d.References[key]
	if exists && r.InboxCanceled && r.InboxCancelPending && r.InboxNodeID == d.NodeID {
		r.InboxCancelPending = false
		d.References[key] = r
		retainReference(d, key)
	}
}

// CanceledInbox returns cancellation proof only for exact pending references
// supplied by Node. Missing references never imply cancellation. The owner
// retains this proof until Node durably removes the inbox entry and consumes
// it, or a later durable empty snapshot proves removal after a crashed reply.
func (c *Core) CanceledInbox(raw json.RawMessage) ([]MessageRef, error) {
	var snapshot struct {
		Pending []struct {
			Message MessageRef `json:"message"`
		} `json:"pending"`
		Before int64 `json:"before"`
	}
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Before <= 0 || len(snapshot.Pending) > 1000 {
		return nil, fault("invalid_argument", "invalid pending inbox snapshot")
	}
	d, err := c.store.DurableSnapshot()
	if err != nil {
		return nil, err
	}
	canceled := make([]MessageRef, 0)
	seen := map[string]bool{}
	for _, item := range snapshot.Pending {
		if !item.Message.valid() {
			return nil, fault("invalid_argument", "full pending inbox reference is required")
		}
		key := item.Message.key()
		r, exists := d.References[key]
		if exists && r.InboxCanceled && r.InboxNodeID == d.NodeID && !seen[key] {
			canceled = append(canceled, r.Message)
			seen[key] = true
		}
	}
	return canceled, nil
}

// ReconcileInbox repairs a crash between Node's durable inbox deletion and its
// consume RPC. Only already-queued local deliveries older than the snapshot
// are releasable: an ingest may still be in flight while Node takes a snapshot.
func (c *Core) ReconcileInbox(ctx context.Context, raw json.RawMessage) error {
	var snapshot struct {
		Pending []struct {
			Message MessageRef `json:"message"`
		} `json:"pending"`
		Before int64 `json:"before"`
	}
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Before <= 0 || len(snapshot.Pending) > 1000 {
		return fault("invalid_argument", "invalid pending inbox snapshot")
	}
	pending := map[string]MessageRef{}
	for _, item := range snapshot.Pending {
		if !item.Message.valid() {
			return fault("invalid_argument", "full pending inbox reference is required")
		}
		pending[item.Message.key()] = item.Message
	}
	var release []MessageRef
	err := c.store.Update(func(d *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		for key, message := range pending {
			r, exists := d.References[key]
			if !exists {
				return fault("not_found", "pending inbox return route is missing")
			}
			if r.InboxNodeID != "" && r.InboxNodeID != d.NodeID {
				return fault("permission_denied", "pending inbox belongs to another node")
			}
			if r.InboxCanceled {
				// Node may still have the canceled queued entry in its durable
				// snapshot. It cannot resurrect the released core obligation.
				continue
			}
			if r.InboxState != "pending" && r.InboxUpdatedAt < snapshot.Before {
				r.InboxState, r.InboxNodeID = "pending", d.NodeID
				r.InboxReleasedRoutes = nil
				r.InboxUpdatedAt = nextInboxStamp(d, r.InboxUpdatedAt)
				d.References[key] = r
			}
			remember(d, message, "")
		}
		for key, reference := range d.References {
			if !reference.InboxCancelPending || !reference.InboxCanceled || reference.InboxNodeID != d.NodeID || reference.InboxUpdatedAt >= snapshot.Before {
				continue
			}
			if _, exists := pending[key]; !exists {
				// Durable Node deletion may have succeeded before the consume
				// RPC was lost. A newer empty snapshot is its acknowledgment.
				acknowledgeCanceledInbox(d, key)
				release = append(release, reference.Message)
			}
		}
		seen := map[string]bool{}
		for id, delivery := range d.Deliveries {
			queued := delivery.Status == "delivered" && delivery.Transport == "inbox_queued" && delivery.InboxQueuedAt < snapshot.Before
			rejected := delivery.Status == "rejected" && d.Retention.Deliveries[id]/int64(time.Millisecond) < snapshot.Before
			if !queued && !rejected {
				continue
			}
			event, exists := d.Events[delivery.EventID]
			if !exists || event.Event.Session.NodeID != d.NodeID || !polledInbox(event.Event.Session.Adapter) {
				continue
			}
			message := event.Event.Message
			key := message.key()
			if _, exists := pending[key]; exists || seen[key] {
				continue
			}
			seen[key] = true
			markInboxConsumed(d, message)
			release = append(release, message)
		}
		return nil
	})
	if err != nil {
		return err
	}
	var first error
	for _, message := range release {
		if err := c.ReleaseInbox(ctx, message); err != nil && first == nil {
			first = err
		}
	}
	return first
}

type inboxRetryState struct {
	cursor        string
	releaseCursor string
	next          map[string]time.Time
	failed        map[string]uint8
	phase         map[string]string
}

const inboxSweepBatch = 8
const inboxSweepBudget = 5 * time.Second
const inboxRouteAttemptBudget = time.Second

func (c *Core) retryInboxReleases() { c.retryInboxBatch(&inboxRetryState{}) }

func (c *Core) retryInboxBatch(retry *inboxRetryState) {
	if retry.next == nil {
		retry.next, retry.failed, retry.phase = map[string]time.Time{}, map[string]uint8{}, map[string]string{}
	}
	d := c.store.Snapshot()
	at := c.store.clock()
	for key := range retry.next {
		if !inboxReferenceHeld(d.References[key]) {
			delete(retry.next, key)
			delete(retry.failed, key)
			delete(retry.phase, key)
		}
	}
	releases, probes := make([]string, 0), make([]string, 0)
	for key, reference := range d.References {
		releasing := reference.InboxState == "releasing"
		oldTransit := reference.InboxState == "pending" && reference.InboxNodeID != d.NodeID && reference.InboxUpdatedAt <= at.Add(-terminalRetention).UnixMilli()
		if !releasing && !oldTransit {
			continue
		}
		if releasing && retry.phase[key] != "releasing" {
			delete(retry.next, key) // A new release intent bypasses probe backoff.
			delete(retry.failed, key)
		}
		if releasing {
			releases = append(releases, key)
		} else {
			probes = append(probes, key)
		}
	}
	if len(releases)+len(probes) == 0 {
		return
	}
	// Explicit consumed outbox work takes priority over speculative history
	// probes; each class rotates independently so a large ledger stays fair.
	keys := make([]string, 0, len(releases)+len(probes))
	for i, group := range [][]string{releases, probes} {
		sort.Strings(group)
		cursor := retry.releaseCursor
		if i == 1 {
			cursor = retry.cursor
		}
		start := sort.Search(len(group), func(i int) bool { return group[i] > cursor })
		keys = append(keys, group[start:]...)
		keys = append(keys, group[:start]...)
	}
	request, cancel := context.WithTimeout(c.ctx, inboxSweepBudget)
	defer cancel()
	attempts := 0
	for _, key := range keys {
		if attempts >= inboxSweepBatch {
			break
		}
		if retry.next[key].After(at) {
			continue
		}
		if request.Err() != nil {
			return
		}
		attempts++
		reference := d.References[key]
		if reference.InboxState == "releasing" {
			retry.releaseCursor = key
		} else {
			retry.cursor = key
		}
		var err error
		var stillPending bool
		if reference.InboxState == "pending" {
			var consumed bool
			consumed, err = c.InboxConsumed(request, reference.Message)
			stillPending = err == nil && !consumed
		}
		if err == nil && !stillPending {
			err = c.ReleaseInbox(request, reference.Message)
		}
		retry.phase[key] = reference.InboxState
		if err != nil {
			failure := retry.failed[key]
			if failure < 5 {
				retry.failed[key] = failure + 1
			}
			delay := 30 * time.Second * time.Duration(1<<failure)
			if delay > 15*time.Minute {
				delay = 15 * time.Minute
			}
			retry.next[key] = at.Add(delay)
			if c.ctx.Err() == nil {
				c.log("inbox_release_pending", "", reference.Message.MessageID)
			}
		} else if stillPending {
			retry.next[key] = at.Add(time.Hour)
			delete(retry.failed, key)
		} else {
			delete(retry.next, key)
			delete(retry.failed, key)
			delete(retry.phase, key)
		}
	}
}

func (c *Core) startInboxReleases() {
	c.inboxReleaseOnce.Do(func() {
		c.inboxReleaseWG.Add(1)
		go func() {
			defer c.inboxReleaseWG.Done()
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			retry := &inboxRetryState{}
			for {
				c.retryInboxBatch(retry)
				select {
				case <-c.ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	})
}
