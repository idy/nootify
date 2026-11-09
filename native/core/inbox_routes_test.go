package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

type inboxTestRoute struct {
	*fakeProvider
	target   *Core
	offline  atomic.Bool
	releases atomic.Int64
	statuses atomic.Int64
	status   func(context.Context, MessageRef) (bool, error)
	release  func(context.Context, MessageRef) error
}

func (p *inboxTestRoute) ReleaseInbox(ctx context.Context, m MessageRef) error {
	p.releases.Add(1)
	if p.release != nil {
		return p.release(ctx, m)
	}
	if p.offline.Load() {
		return errors.New("synthetic offline inbox return route")
	}
	return p.target.ReleaseInbox(ctx, m)
}
func (p *inboxTestRoute) InboxConsumed(ctx context.Context, m MessageRef) (bool, error) {
	p.statuses.Add(1)
	if p.status != nil {
		return p.status(ctx, m)
	}
	if p.offline.Load() {
		return false, errors.New("synthetic offline inbox status route")
	}
	return p.target.InboxConsumed(ctx, m)
}
func (p *inboxTestRoute) Reply(ctx context.Context, m MessageRef, content Content, request string) (SendResult, error) {
	return p.target.Reply(ctx, m, content, request)
}
func (p *inboxTestRoute) Ack(ctx context.Context, m MessageRef) error {
	_, err := p.target.Ack(ctx, m)
	return err
}

func installInboxTestRoute(c *Core, id string, target *Core) *inboxTestRoute {
	route := &inboxTestRoute{fakeProvider: &fakeProvider{id: id, node: target.node()}, target: target}
	c.mu.Lock()
	c.providers[id], c.statuses[id] = route, "connected"
	c.mu.Unlock()
	return route
}

func queuedInboxCore(t *testing.T) *Core {
	t.Helper()
	c := testCore(t, nil)
	c.emit = func(kind string, data any) error {
		if kind != "delivery" {
			return nil
		}
		id := data.(map[string]any)["delivery_id"].(string)
		return c.Complete(id, "delivered", "inbox_queued", "")
	}
	return c
}

func setInboxTestClock(c *Core, at *time.Time) { c.store.clock = func() time.Time { return *at } }

func TestInboxRoutesHoldMultiHopForkUntilConsumptionThenReclaim(t *testing.T) {
	ctx := context.Background()
	origin, left, right, leaf := testCore(t, nil), testCore(t, nil), testCore(t, nil), queuedInboxCore(t)
	at := time.Now().UTC()
	cores := []*Core{origin, left, right, leaf}
	for _, c := range cores {
		setInboxTestClock(c, &at)
	}
	bot := installFake(t, origin, "source-bot")
	installInboxTestRoute(left, "origin", origin)
	installInboxTestRoute(right, "origin", origin)
	leftRoute := installInboxTestRoute(leaf, "left", left)
	rightRoute := installInboxTestRoute(leaf, "right", right)
	event := eventFor(leaf.node(), "queued-multi-hop")
	event.Session.Adapter = "trae"
	event.Message = MessageRef{OriginNodeID: origin.node(), ProviderID: "source-bot", MessageID: "queued-multi-hop", ThreadID: "original-thread"}
	must(t, origin.Ingest(ctx, event, ""))
	source := origin.store.Snapshot().Events[event.ID].Event
	must(t, left.Ingest(ctx, source, "origin"))
	must(t, right.Ingest(ctx, source, "origin"))
	must(t, leaf.Ingest(ctx, left.store.Snapshot().Events[event.ID].Event, "left"))
	must(t, leaf.Ingest(ctx, right.store.Snapshot().Events[event.ID].Event, "right"))
	at = at.Add(90 * 24 * time.Hour)
	for _, c := range cores {
		must(t, c.store.Update(func(*State) error { return nil }))
		d := c.store.Snapshot()
		if _, exists := d.Events[event.ID]; !exists || d.References[event.Message.key()].InboxState != "pending" {
			t.Fatal("confirmed relay ingestion lost an unconsumed inbox obligation")
		}
		for _, peer := range d.Peers {
			if len(peer.Pending) != 0 {
				t.Fatal("fixture unexpectedly relied on a pending peer window")
			}
		}
	}
	// A structured callback must still traverse an intermediate route after its
	// ordinary event/reference horizons have elapsed.
	_, err := leaf.Reply(ctx, event.Message, Content{Text: "synthetic callback"}, "callback")
	must(t, err)
	bot.mu.Lock()
	if bot.replies != 1 || bot.lastReply != event.Message {
		bot.mu.Unlock()
		t.Fatal("queued callback lost its original multi-hop message/thread")
	}
	bot.mu.Unlock()
	must(t, leaf.ConsumeInbox(ctx, event.Message))
	must(t, leaf.ConsumeInbox(ctx, event.Message)) // Idempotent, no business retry.
	for _, c := range cores {
		if c.store.Snapshot().References[event.Message.key()].InboxState != "consumed" {
			t.Fatal("consumption did not release every upstream branch")
		}
	}
	if leftRoute.releases.Load() != 1 || rightRoute.releases.Load() != 1 {
		t.Fatal("release skipped a fork or unnecessarily repeated a completed branch")
	}
	for _, delivery := range leaf.store.Snapshot().Deliveries {
		if delivery.Transport != "inbox_consumed" {
			t.Fatal("consumption did not release the leaf queue obligation")
		}
	}
	late := testCore(t, nil)
	setInboxTestClock(late, &at)
	cores = append(cores, late)
	installInboxTestRoute(late, "origin", origin)
	lateRoute := installInboxTestRoute(leaf, "late", late)
	must(t, late.Ingest(ctx, source, "origin"))
	must(t, leaf.Ingest(ctx, late.store.Snapshot().Events[event.ID].Event, "late"))
	if leaf.store.Snapshot().References[event.Message.key()].InboxState != "releasing" || len(leaf.store.Snapshot().Deliveries) != 1 {
		t.Fatal("late alternate route was not scheduled for release or requeued consumed input")
	}
	must(t, leaf.ReleaseInbox(ctx, event.Message))
	if lateRoute.releases.Load() != 1 || leftRoute.releases.Load() != 1 || rightRoute.releases.Load() != 1 || late.store.Snapshot().References[event.Message.key()].InboxState != "consumed" {
		t.Fatal("late alternate branch was not independently released")
	}
	at = at.Add(referenceRetention)
	for _, c := range cores {
		must(t, c.store.Update(func(*State) error { return nil }))
		d := c.store.Snapshot()
		if _, exists := d.Events[event.ID]; exists {
			t.Fatal("consumed relay event remained permanently pinned")
		}
		if _, exists := d.References[event.Message.key()]; exists {
			t.Fatal("consumed relay return route remained permanently pinned")
		}
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()
	if bot.replies != 1 || bot.sends != 0 {
		t.Fatal("release retried a business send or reply")
	}
}

func TestInboxRoutesOfflineForkReleaseSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	origin, healthy, offline, leaf := testCore(t, nil), testCore(t, nil), testCore(t, nil), queuedInboxCore(t)
	installInboxTestRoute(healthy, "origin", origin)
	installInboxTestRoute(offline, "origin", origin)
	completed := installInboxTestRoute(leaf, "healthy", healthy)
	pending := installInboxTestRoute(leaf, "offline", offline)
	pending.offline.Store(true)
	event := eventFor(leaf.node(), "offline-fork")
	event.Session.Adapter = "workbuddy"
	event.Message = MessageRef{OriginNodeID: origin.node(), ProviderID: "synthetic-bot", MessageID: event.ID}
	must(t, origin.Ingest(ctx, event, ""))
	source := origin.store.Snapshot().Events[event.ID].Event
	must(t, healthy.Ingest(ctx, source, "origin"))
	must(t, offline.Ingest(ctx, source, "origin"))
	must(t, leaf.Ingest(ctx, healthy.store.Snapshot().Events[event.ID].Event, "healthy"))
	must(t, leaf.Ingest(ctx, offline.store.Snapshot().Events[event.ID].Event, "offline"))
	if err := leaf.ConsumeInbox(ctx, event.Message); err == nil {
		t.Fatal("offline release was reported as complete")
	}
	r := leaf.store.Snapshot().References[event.Message.key()]
	if r.InboxState != "releasing" || !contains(r.InboxReleasedRoutes, "healthy") || contains(r.InboxReleasedRoutes, "offline") || completed.releases.Load() != 1 {
		t.Fatal("fork release progress was not durably tracked independently")
	}
	leaf = reopenCore(t, leaf, nil)
	completedAfterRestart := installInboxTestRoute(leaf, "healthy", healthy)
	pendingAfterRestart := installInboxTestRoute(leaf, "offline", offline)
	must(t, leaf.Start())
	await(t, func() bool { return leaf.store.Snapshot().References[event.Message.key()].InboxState == "consumed" })
	if completedAfterRestart.releases.Load() != 0 || pendingAfterRestart.releases.Load() != 1 {
		t.Fatal("restart lost per-route progress or failed to retry the offline branch")
	}
	if offline.store.Snapshot().References[event.Message.key()].InboxState != "consumed" {
		t.Fatal("recovered release did not reach the previously offline upstream")
	}
}

func TestInboxRoutesSlowFirstRouteDoesNotStarveHealthyRelease(t *testing.T) {
	origin, leaf := testCore(t, nil), testCore(t, nil)
	slow := installInboxTestRoute(leaf, "a-slow", origin)
	healthy := installInboxTestRoute(leaf, "b-healthy", origin)
	slow.release = func(ctx context.Context, _ MessageRef) error { <-ctx.Done(); return ctx.Err() }
	m := MessageRef{OriginNodeID: origin.node(), ProviderID: "synthetic", MessageID: "slow-first"}
	must(t, leaf.store.Update(func(d *State) error {
		d.References[m.key()] = ReferenceRecord{Message: m, Routes: []string{"a-slow", "b-healthy"}, InboxState: "releasing", InboxNodeID: d.NodeID, InboxUpdatedAt: inboxTimestamp(d)}
		return nil
	}))
	started := time.Now()
	leaf.retryInboxReleases()
	r := leaf.store.Snapshot().References[m.key()]
	if healthy.releases.Load() != 1 || !contains(r.InboxReleasedRoutes, "b-healthy") || contains(r.InboxReleasedRoutes, "a-slow") || r.InboxState != "releasing" {
		t.Fatal("slow first route starved a healthy release or discarded its pending branch")
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("one hanging route consumed the entire five-second sweep budget")
	}
}

func TestInboxRoutesAttemptRotationAndProgressSurviveRestart(t *testing.T) {
	origin, leaf := testCore(t, nil), testCore(t, nil)
	slow := installInboxTestRoute(leaf, "a-slow", origin)
	slow.release = func(ctx context.Context, _ MessageRef) error { <-ctx.Done(); return ctx.Err() }
	m := MessageRef{OriginNodeID: origin.node(), ProviderID: "synthetic", MessageID: "restart-fairness"}
	must(t, leaf.store.Update(func(d *State) error {
		d.References[m.key()] = ReferenceRecord{Message: m, Routes: []string{"a-slow", "b-healthy", "c-healthy"}, InboxState: "releasing", InboxNodeID: d.NodeID, InboxUpdatedAt: inboxTimestamp(d)}
		return nil
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	if err := leaf.ReleaseInbox(ctx, m); err == nil {
		t.Fatal("fixture hanging release unexpectedly succeeded")
	}
	cancel()
	if leaf.store.Snapshot().References[m.key()].InboxReleaseCursor != "a-slow" {
		t.Fatal("attempt rotation was not persisted before hanging network I/O")
	}
	leaf = reopenCore(t, leaf, nil)
	slow = installInboxTestRoute(leaf, "a-slow", origin)
	slow.release = func(ctx context.Context, _ MessageRef) error { <-ctx.Done(); return ctx.Err() }
	first := installInboxTestRoute(leaf, "b-healthy", origin)
	second := installInboxTestRoute(leaf, "c-healthy", origin)
	ctx, cancel = context.WithTimeout(context.Background(), 200*time.Millisecond)
	_ = leaf.ReleaseInbox(ctx, m)
	cancel()
	r := leaf.store.Snapshot().References[m.key()]
	if first.releases.Load() != 1 || second.releases.Load() != 1 || !contains(r.InboxReleasedRoutes, "b-healthy") || !contains(r.InboxReleasedRoutes, "c-healthy") {
		t.Fatal("restart repeated the hanging route before progressing healthy branches")
	}
	slow.release = nil
	must(t, leaf.ReleaseInbox(context.Background(), m))
	if leaf.store.Snapshot().References[m.key()].InboxState != "consumed" || first.releases.Load() != 1 || second.releases.Load() != 1 {
		t.Fatal("completed routes were retried or the recovered slow branch was lost")
	}
}

func TestInboxRoutesManyHangingRoutesShareFiveSecondBudget(t *testing.T) {
	origin, leaf := testCore(t, nil), testCore(t, nil)
	m := MessageRef{OriginNodeID: origin.node(), ProviderID: "synthetic", MessageID: "overall-route-budget"}
	var routes []string
	for i := 0; i < inboxSweepBatch; i++ {
		id := fmt.Sprintf("slow-%02d", i)
		routes = append(routes, id)
		provider := installInboxTestRoute(leaf, id, origin)
		provider.release = func(ctx context.Context, _ MessageRef) error { <-ctx.Done(); return ctx.Err() }
	}
	must(t, leaf.store.Update(func(d *State) error {
		d.References[m.key()] = ReferenceRecord{Message: m, Routes: routes, InboxState: "releasing", InboxNodeID: d.NodeID, InboxUpdatedAt: inboxTimestamp(d)}
		return nil
	}))
	started := time.Now()
	if err := leaf.ReleaseInbox(context.Background(), m); err == nil {
		t.Fatal("hanging routes incorrectly reported complete release")
	}
	if elapsed := time.Since(started); elapsed > inboxSweepBudget+time.Second {
		t.Fatalf("independent route timeouts exceeded the shared five-second budget: %s", elapsed)
	}
	if r := leaf.store.Snapshot().References[m.key()]; r.InboxState != "releasing" || len(r.InboxReleasedRoutes) != 0 || r.InboxReleaseCursor == "" {
		t.Fatal("bounded sweep lost its pending branches or durable rotation")
	}
}

func TestInboxRoutesEachCallBoundsRouteAttempts(t *testing.T) {
	origin, leaf := testCore(t, nil), testCore(t, nil)
	m := MessageRef{OriginNodeID: origin.node(), ProviderID: "synthetic", MessageID: "bounded-routes"}
	var routes []string
	var providers []*inboxTestRoute
	for i := 0; i < inboxSweepBatch+3; i++ {
		id := fmt.Sprintf("route-%02d", i)
		routes = append(routes, id)
		providers = append(providers, installInboxTestRoute(leaf, id, origin))
	}
	must(t, leaf.store.Update(func(d *State) error {
		d.References[m.key()] = ReferenceRecord{Message: m, Routes: routes, InboxState: "releasing", InboxNodeID: d.NodeID, InboxUpdatedAt: inboxTimestamp(d)}
		return nil
	}))
	if err := leaf.ReleaseInbox(context.Background(), m); err == nil {
		t.Fatal("bounded first call incorrectly claimed all routes released")
	}
	if len(leaf.store.Snapshot().References[m.key()].InboxReleasedRoutes) != inboxSweepBatch {
		t.Fatal("release call exceeded its route-attempt bound")
	}
	must(t, leaf.ReleaseInbox(context.Background(), m))
	for _, provider := range providers {
		if provider.releases.Load() != 1 {
			t.Fatal("route was skipped or its successful release was repeated")
		}
	}
}

func TestInboxRoutesUnusedBroadcastBranchesEventuallyRelease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	origin, owner, sibling, relay, unused := testCore(t, nil), queuedInboxCore(t), testCore(t, nil), testCore(t, nil), testCore(t, nil)
	at := time.Now().UTC()
	cores := []*Core{origin, owner, sibling, relay, unused}
	for _, c := range cores {
		setInboxTestClock(c, &at)
	}
	installInboxTestRoute(owner, "origin", origin)
	installInboxTestRoute(sibling, "origin", origin)
	relayRoute := installInboxTestRoute(relay, "origin", origin)
	installInboxTestRoute(unused, "relay", relay)
	subscriptions := make(map[*Core]*Subscription)
	for _, child := range []*Core{owner, sibling, relay} {
		sub, err := origin.Subscribe(ctx, child.node(), "")
		must(t, err)
		defer sub.Close()
		subscriptions[child] = sub
	}
	unusedSub, err := relay.Subscribe(ctx, unused.node(), "")
	must(t, err)
	defer unusedSub.Close()
	event := eventFor(owner.node(), "broadcast-with-unused-branches")
	event.Session.Adapter = "trae"
	event.Message = MessageRef{OriginNodeID: origin.node(), ProviderID: "synthetic", MessageID: event.ID}
	must(t, origin.Ingest(ctx, event, ""))
	for _, child := range []*Core{owner, sibling, relay} {
		got, err := subscriptions[child].Next()
		must(t, err)
		must(t, child.Ingest(ctx, got, "origin"))
		must(t, subscriptions[child].Confirm(got.ID))
	}
	got, err := unusedSub.Next()
	must(t, err)
	must(t, unused.Ingest(ctx, got, "relay"))
	must(t, unusedSub.Confirm(got.ID))
	at = at.Add(90 * 24 * time.Hour)
	for _, c := range cores {
		c.retryInboxReleases()
		must(t, c.store.Update(func(*State) error { return nil }))
		if c.store.Snapshot().References[event.Message.key()].InboxState != "pending" {
			t.Fatal("status cleanup dropped a branch before actual inbox consumption")
		}
	}
	must(t, owner.ConsumeInbox(ctx, event.Message))
	sibling.retryInboxReleases()
	if sibling.store.Snapshot().References[event.Message.key()].InboxState != "consumed" {
		t.Fatal("unused direct sibling never learned owner consumption")
	}
	relayRoute.offline.Store(true)
	unused.retryInboxReleases()
	if unused.store.Snapshot().References[event.Message.key()].InboxState != "pending" {
		t.Fatal("unavailable consumption authority was treated as completion")
	}
	// Completion remains provable after canonical completed history expires;
	// pending canonical records could never have been removed by retention.
	at = at.Add(referenceRetention)
	must(t, origin.store.Update(func(*State) error { return nil }))
	if _, exists := origin.store.Snapshot().References[event.Message.key()]; exists {
		t.Fatal("completed canonical fixture did not expire")
	}
	relayRoute.offline.Store(false)
	unused.retryInboxReleases()
	for _, c := range []*Core{relay, unused} {
		if c.store.Snapshot().References[event.Message.key()].InboxState != "consumed" {
			t.Fatal("unused relay branch remained permanently pinned after recovery")
		}
	}
	at = at.Add(referenceRetention)
	for _, c := range cores {
		must(t, c.store.Update(func(*State) error { return nil }))
		d := c.store.Snapshot()
		if _, exists := d.Events[event.ID]; exists {
			t.Fatal("completed unused branch retained its event forever")
		}
		if _, exists := d.References[event.Message.key()]; exists {
			t.Fatal("completed unused branch retained its return reference forever")
		}
	}
}

func TestInboxRoutesUpgradeBackfillsPendingButPreservesConsumed(t *testing.T) {
	c := testCore(t, nil)
	pending := eventFor("owner", "legacy-pending")
	pending.Session.Adapter = "workbuddy"
	pending.Message.OriginNodeID = c.node()
	consumed := pending
	consumed.ID, consumed.Message.MessageID = "legacy-consumed", "legacy-consumed"
	must(t, c.store.Update(func(d *State) error {
		for _, event := range []Event{pending, consumed} {
			d.Events[event.ID] = EventRecord{Event: event, Outcome: "broadcast"}
			remember(d, event.Message, "")
		}
		r := d.References[consumed.Message.key()]
		r.InboxState, r.InboxNodeID = "consumed", consumed.Session.NodeID
		d.References[consumed.Message.key()] = r
		return nil
	}))
	c = reopenCore(t, c, nil)
	d := c.store.Snapshot()
	if d.References[pending.Message.key()].InboxState != "pending" || d.References[consumed.Message.key()].InboxState != "consumed" {
		t.Fatal("upgrade failed to backfill outstanding legacy hold or reopened a consumed one")
	}
	at := time.Now().Add(90 * 24 * time.Hour)
	setInboxTestClock(c, &at)
	must(t, c.store.Update(func(*State) error { return nil }))
	complete, err := c.InboxConsumed(context.Background(), pending.Message)
	must(t, err)
	if complete || c.store.Snapshot().References[pending.Message.key()].InboxState != "pending" {
		t.Fatal("upgraded pending canonical hold expired")
	}
	complete, err = c.InboxConsumed(context.Background(), consumed.Message)
	must(t, err)
	if !complete {
		t.Fatal("expired completed canonical history lost its completion proof")
	}
}

func TestInboxRoutesSweepBatchesBacksOffAndSkipsFreshOrOwnerHolds(t *testing.T) {
	origin, relay := testCore(t, nil), testCore(t, nil)
	at := time.Now().UTC()
	setInboxTestClock(origin, &at)
	setInboxTestClock(relay, &at)
	route := installInboxTestRoute(relay, "origin", origin)
	originID, relayID := origin.node(), relay.node()
	const records = 2*inboxSweepBatch + 4
	for _, c := range []*Core{origin, relay} {
		must(t, c.store.Update(func(d *State) error {
			for i := 0; i < records+2; i++ {
				m := MessageRef{OriginNodeID: originID, ProviderID: "synthetic", MessageID: fmt.Sprintf("batch-%02d", i)}
				stamp := at.Add(-terminalRetention - time.Hour).UnixMilli()
				node := "other-owner"
				if i == records {
					stamp = at.UnixMilli()
				}
				if i == records+1 {
					node = relayID
				}
				r := ReferenceRecord{Message: m, InboxState: "pending", InboxNodeID: node, InboxUpdatedAt: stamp}
				if c == relay {
					r.Routes = []string{"origin"}
				}
				d.References[m.key()] = r
			}
			return nil
		}))
	}
	retry := &inboxRetryState{}
	relay.retryInboxBatch(retry)
	if route.statuses.Load() != inboxSweepBatch {
		t.Fatal("worker did not enforce its per-sweep batch bound")
	}
	relay.retryInboxBatch(retry)
	relay.retryInboxBatch(retry)
	if route.statuses.Load() != records {
		t.Fatal("round-robin worker starved eligible records or probed fresh/owner holds")
	}
	relay.retryInboxBatch(retry)
	if route.statuses.Load() != records {
		t.Fatal("canonical pending status did not back off")
	}
	at = at.Add(time.Hour)
	route.offline.Store(true)
	relay.retryInboxBatch(retry)
	failed := route.statuses.Load()
	relay.retryInboxBatch(retry)
	relay.retryInboxBatch(retry)
	relay.retryInboxBatch(retry)
	if route.statuses.Load() != records*2 || failed != records+inboxSweepBatch {
		t.Fatal("failure backoff or bounded retry batching was not respected")
	}
	local := MessageRef{OriginNodeID: relayID, ProviderID: "synthetic", MessageID: "zz-urgent-release"}
	must(t, relay.store.Update(func(d *State) error {
		d.References[local.key()] = ReferenceRecord{Message: local, InboxState: "releasing", InboxNodeID: relayID, InboxUpdatedAt: at.UnixMilli()}
		return nil
	}))
	before := route.statuses.Load()
	relay.retryInboxBatch(&inboxRetryState{})
	if relay.store.Snapshot().References[local.key()].InboxState != "consumed" || route.statuses.Load()-before != inboxSweepBatch-1 {
		t.Fatal("history probes starved an explicit consumed release intent")
	}
}

func TestInboxRoutesCloseCancelsConsumptionProbe(t *testing.T) {
	origin, relay := testCore(t, nil), testCore(t, nil)
	route := installInboxTestRoute(relay, "origin", origin)
	started := make(chan struct{})
	route.status = func(ctx context.Context, _ MessageRef) (bool, error) {
		close(started)
		<-ctx.Done()
		return false, ctx.Err()
	}
	m := MessageRef{OriginNodeID: origin.node(), ProviderID: "synthetic", MessageID: "cancel-status"}
	must(t, relay.store.Update(func(d *State) error {
		d.References[m.key()] = ReferenceRecord{Message: m, Routes: []string{"origin"}, InboxState: "pending", InboxNodeID: "other-owner", InboxUpdatedAt: time.Now().Add(-terminalRetention - time.Hour).UnixMilli()}
		return nil
	}))
	must(t, relay.Start())
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background consumption probe did not start")
	}
	before := time.Now()
	relay.Close()
	if time.Since(before) > time.Second {
		t.Fatal("close waited for an uncanceled network probe")
	}
	if relay.store.Snapshot().References[m.key()].InboxState != "pending" {
		t.Fatal("canceled status probe discarded a pending hold")
	}
}

func TestInboxRoutesSnapshotDoesNotReleaseNewerQueueOrReopenLaterConsumption(t *testing.T) {
	c := queuedInboxCore(t)
	at := time.Now().UTC().Truncate(time.Millisecond)
	setInboxTestClock(c, &at)
	makeEvent := func(id string) Event {
		e := eventFor(c.node(), id)
		e.Session.Adapter = "trae"
		e.Message.OriginNodeID = c.node()
		return e
	}
	old, newer := makeEvent("old-queue"), makeEvent("new-queue")
	must(t, c.Ingest(context.Background(), old, ""))
	before := at.Add(time.Millisecond).UnixMilli()
	at = at.Add(2 * time.Millisecond)
	must(t, c.Ingest(context.Background(), newer, ""))
	raw, err := json.Marshal(map[string]any{"pending": []any{}, "before": before})
	must(t, err)
	must(t, c.ReconcileInbox(context.Background(), raw))
	d := c.store.Snapshot()
	if d.References[old.Message.key()].InboxState != "consumed" || d.References[newer.Message.key()].InboxState != "pending" {
		t.Fatal("snapshot released a later queue completion or failed to repair a missing acknowledgment")
	}
	// A stale pending snapshot must not undo an acknowledgment made after its
	// boundary, otherwise a consumed inbox would become permanently pinned.
	raw, err = json.Marshal(map[string]any{"pending": []any{map[string]any{"message": old.Message}}, "before": before})
	must(t, err)
	must(t, c.ReconcileInbox(context.Background(), raw))
	if c.store.Snapshot().References[old.Message.key()].InboxState != "consumed" {
		t.Fatal("stale snapshot resurrected an already consumed inbox")
	}
}

func TestInboxRoutesCanceledQueueProofSurvivesOfflineUntilNodeAcknowledges(t *testing.T) {
	c := queuedInboxCore(t)
	at := time.Now().UTC()
	setInboxTestClock(c, &at)
	event := eventFor(c.node(), "canceled-offline-inbox")
	event.Session.Adapter = "trae"
	event.Message.OriginNodeID, event.Message.ThreadID = c.node(), "retained-thread"
	must(t, c.Ingest(context.Background(), event, ""))
	must(t, c.store.Update(func(d *State) error { cancelEvent(d, event.ID); return nil }))
	must(t, c.ReleaseInbox(context.Background(), event.Message))
	if r := c.store.Snapshot().References[event.Message.key()]; !r.InboxCanceled || !r.InboxCancelPending || r.InboxState != "consumed" {
		t.Fatal("actual canceled local queue did not retain an unacknowledged cancellation proof")
	}
	at = at.Add(90 * 24 * time.Hour)
	must(t, c.store.Update(func(*State) error { return nil }))
	if _, exists := c.store.Snapshot().Events[event.ID]; exists {
		t.Fatal("cancellation proof unnecessarily retained the completed payload")
	}
	c = reopenCore(t, c, nil)
	setInboxTestClock(c, &at)
	raw, err := json.Marshal(map[string]any{"pending": []any{map[string]any{"message": event.Message}}, "before": at.UnixMilli()})
	must(t, err)
	must(t, c.ReconcileInbox(context.Background(), raw))
	canceled, err := c.CanceledInbox(raw)
	must(t, err)
	if len(canceled) != 1 || canceled[0] != event.Message || !c.store.Snapshot().References[event.Message.key()].InboxCancelPending {
		t.Fatal("long-offline Node could not obtain exact cancellation proof without reopening the hold")
	}
	must(t, c.ConsumeInbox(context.Background(), event.Message)) // After Node's durable deletion.
	if c.store.Snapshot().References[event.Message.key()].InboxCancelPending {
		t.Fatal("Node acknowledgment did not release its cancellation-proof pin")
	}
	at = at.Add(referenceRetention)
	must(t, c.store.Update(func(*State) error { return nil }))
	if _, exists := c.store.Snapshot().References[event.Message.key()]; exists {
		t.Fatal("acknowledged cancellation proof remained pinned forever")
	}
}

func TestInboxRoutesEmptySnapshotRecoversCanceledQueueAcknowledgment(t *testing.T) {
	c := queuedInboxCore(t)
	at := time.Now().UTC()
	setInboxTestClock(c, &at)
	event := eventFor(c.node(), "lost-canceled-ack")
	event.Session.Adapter, event.Message.OriginNodeID = "workbuddy", c.node()
	must(t, c.Ingest(context.Background(), event, ""))
	at = at.Add(time.Hour)
	must(t, c.store.Update(func(d *State) error { cancelEvent(d, event.ID); return nil }))
	must(t, c.ReleaseInbox(context.Background(), event.Message))
	stamp := c.store.Snapshot().References[event.Message.key()].InboxUpdatedAt
	stale, err := json.Marshal(map[string]any{"pending": []any{}, "before": stamp - 1})
	must(t, err)
	must(t, c.ReconcileInbox(context.Background(), stale))
	if !c.store.Snapshot().References[event.Message.key()].InboxCancelPending {
		t.Fatal("older empty snapshot acknowledged a future cancellation")
	}
	// Node's durable deletion succeeded, but its consume RPC was lost. Core
	// restarts and later receives a newer authoritative empty inbox snapshot.
	c = reopenCore(t, c, nil)
	at = at.Add(time.Hour)
	setInboxTestClock(c, &at)
	empty, err := json.Marshal(map[string]any{"pending": []any{}, "before": at.UnixMilli()})
	must(t, err)
	must(t, c.ReconcileInbox(context.Background(), empty))
	if c.store.Snapshot().References[event.Message.key()].InboxCancelPending {
		t.Fatal("newer empty snapshot did not repair the lost Node cancellation acknowledgment")
	}
	at = at.Add(referenceRetention)
	must(t, c.store.Update(func(*State) error { return nil }))
	if _, exists := c.store.Snapshot().References[event.Message.key()]; exists {
		t.Fatal("recovered empty-snapshot acknowledgment never reclaimed its proof")
	}
}

func TestInboxRoutesCanceledProofListDoesNotInferUnknownOrUnqueuedCancellation(t *testing.T) {
	c := testCore(t, nil)
	at := time.Now().UTC()
	setInboxTestClock(c, &at)
	known := MessageRef{OriginNodeID: c.node(), ProviderID: "synthetic", MessageID: "known-canceled"}
	active := known
	active.MessageID = "active"
	unknown := known
	unknown.MessageID = "unknown"
	unlisted := known
	unlisted.MessageID = "unlisted-canceled"
	must(t, c.store.Update(func(d *State) error {
		for _, m := range []MessageRef{known, unlisted} {
			d.References[m.key()] = ReferenceRecord{Message: m, InboxNodeID: d.NodeID, InboxState: "consumed", InboxCanceled: true, InboxCancelPending: true}
		}
		d.References[active.key()] = ReferenceRecord{Message: active, InboxNodeID: d.NodeID, InboxState: "pending"}
		return nil
	}))
	raw, err := json.Marshal(map[string]any{"pending": []any{map[string]any{"message": known}, map[string]any{"message": known}, map[string]any{"message": active}, map[string]any{"message": unknown}}, "before": at.UnixMilli()})
	must(t, err)
	canceled, err := c.CanceledInbox(raw)
	must(t, err)
	if len(canceled) != 1 || canceled[0] != known {
		t.Fatal("cancellation response included unknown, active, unlisted, or duplicate references")
	}
	// A never-queued canceled event has no Node removal acknowledgment to wait
	// for. Its proof must retain the ordinary finite completion horizon.
	event := eventFor(c.node(), "never-queued")
	event.Session.Adapter, event.Message.OriginNodeID = "trae", c.node()
	must(t, c.store.Update(func(d *State) error {
		d.Events[event.ID] = EventRecord{Event: event, Outcome: "local"}
		d.Deliveries["not-queued"] = Delivery{ID: "not-queued", EventID: event.ID, Status: "retryable"}
		remember(d, event.Message, "")
		holdInbox(d, event, "")
		cancelEvent(d, event.ID)
		return nil
	}))
	must(t, c.ReleaseInbox(context.Background(), event.Message))
	if c.store.Snapshot().References[event.Message.key()].InboxCancelPending {
		t.Fatal("never-queued cancellation acquired an unfulfillable Node acknowledgment pin")
	}
	at = at.Add(90 * 24 * time.Hour)
	must(t, c.store.Update(func(*State) error { return nil }))
	if _, exists := c.store.Snapshot().References[event.Message.key()]; exists {
		t.Fatal("never-queued canceled reference was permanently retained")
	}
}

func TestInboxRoutesAcknowledgmentBeforeQueueCompletionDoesNotRepin(t *testing.T) {
	c := testCore(t, nil)
	var deliveryID string
	c.emit = func(kind string, value any) error {
		if kind == "delivery" {
			deliveryID = value.(map[string]any)["delivery_id"].(string)
		}
		return nil
	}
	event := eventFor(c.node(), "quick-ack")
	event.Session.Adapter = "workbuddy"
	event.Message.OriginNodeID = c.node()
	must(t, c.Ingest(context.Background(), event, ""))
	must(t, c.ConsumeInbox(context.Background(), event.Message))
	if c.store.Snapshot().Deliveries[deliveryID].Status != "delivered" {
		t.Fatal("durable consumption did not prove acceptance of the in-flight queue")
	}
	c = reopenCore(t, c, nil)
	must(t, c.Complete(deliveryID, "delivered", "inbox_queued", ""))
	if c.store.Snapshot().Deliveries[deliveryID].Transport != "inbox_consumed" {
		t.Fatal("late transport completion repinned an already consumed queue")
	}
}
