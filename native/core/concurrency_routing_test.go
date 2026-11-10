package main

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

type routingTestBot struct {
	Bot
	ensure func(context.Context, Session) (Binding, error)
	send   func(context.Context, Binding, Content, string) (SendResult, error)
	reply  func(context.Context, MessageRef, Content, string) (SendResult, error)
}

func (p *routingTestBot) Ensure(ctx context.Context, s Session) (Binding, error) {
	if p.ensure != nil {
		return p.ensure(ctx, s)
	}
	return p.Bot.Ensure(ctx, s)
}
func (p *routingTestBot) Send(ctx context.Context, b Binding, content Content, request string) (SendResult, error) {
	if p.send != nil {
		return p.send(ctx, b, content, request)
	}
	return p.Bot.Send(ctx, b, content, request)
}
func (p *routingTestBot) Reply(ctx context.Context, m MessageRef, content Content, request string) (SendResult, error) {
	if p.reply != nil {
		return p.reply(ctx, m, content, request)
	}
	return p.Bot.Reply(ctx, m, content, request)
}
func waitRouting(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("routing operation did not reach its barrier")
	}
}
func installRoutingBot(c *Core, id string, bot Bot) {
	c.mu.Lock()
	c.providers[id] = bot
	c.mu.Unlock()
}
func barrierCall(ctx context.Context, entered chan<- struct{}, release <-chan struct{}) error {
	select {
	case entered <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func peerStreams(c *Core, node string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for sub := range c.subs[node] {
		if sub.ctx.Err() == nil {
			n++
		}
	}
	return n
}

func TestTwoNodesSimultaneousRemoteEnsureAndSendDoNotDeadlock(t *testing.T) {
	a := testCore(t, nil)
	aBot := installFake(t, a, "local-a")
	addressA, tokenA := testServer(t, a)
	b := testCore(t, nil)
	bBot := installFake(t, b, "local-b")
	addressB, tokenB := testServer(t, b)
	remoteB := addRemote(t, a, "remote-b", addressB, tokenB)
	remoteA := addRemote(t, b, "remote-a", addressA, tokenA)
	must(t, a.store.Update(func(d *State) error { d.DefaultProvider = "local-a"; return nil }))
	must(t, b.store.Update(func(d *State) error { d.DefaultProvider = "local-b"; return nil }))
	entered := make(chan struct{}, 2)
	releaseEnsure := make(chan struct{})
	releaseSend := make(chan struct{})
	gatedA := &routingTestBot{Bot: remoteB}
	gatedB := &routingTestBot{Bot: remoteA}
	gatedA.ensure = func(ctx context.Context, s Session) (Binding, error) {
		if err := barrierCall(ctx, entered, releaseEnsure); err != nil {
			return Binding{}, err
		}
		return remoteB.Ensure(ctx, s)
	}
	gatedB.ensure = func(ctx context.Context, s Session) (Binding, error) {
		if err := barrierCall(ctx, entered, releaseEnsure); err != nil {
			return Binding{}, err
		}
		return remoteA.Ensure(ctx, s)
	}
	gatedA.send = func(ctx context.Context, bind Binding, c Content, request string) (SendResult, error) {
		if err := barrierCall(ctx, entered, releaseSend); err != nil {
			return SendResult{}, err
		}
		return remoteB.Send(ctx, bind, c, request)
	}
	gatedB.send = func(ctx context.Context, bind Binding, c Content, request string) (SendResult, error) {
		if err := barrierCall(ctx, entered, releaseSend); err != nil {
			return SendResult{}, err
		}
		return remoteA.Send(ctx, bind, c, request)
	}
	installRoutingBot(a, "remote-b", gatedA)
	installRoutingBot(b, "remote-a", gatedB)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sA := Session{NodeID: a.node(), Adapter: "codex", SessionID: "from-a"}
	sB := Session{NodeID: b.node(), Adapter: "codex", SessionID: "from-b"}
	results := make(chan error, 2)
	go func() {
		bind, err := a.Ensure(ctx, "remote-b", sA)
		if err == nil && (bind.ProviderID != "remote-b" || bind.Session.key() != sA.key()) {
			err = fmt.Errorf("A lost remote session identity")
		}
		results <- err
	}()
	go func() {
		bind, err := b.Ensure(ctx, "remote-a", sB)
		if err == nil && (bind.ProviderID != "remote-a" || bind.Session.key() != sB.key()) {
			err = fmt.Errorf("B lost remote session identity")
		}
		results <- err
	}()
	waitRouting(t, entered)
	waitRouting(t, entered)
	// Both outbound RPC paths are suspended. Unrelated local sessions must still
	// create/send without waiting for either remote operation to release a gate.
	unrelated, err := a.Ensure(ctx, "local-a", Session{Adapter: "codex", SessionID: "unrelated"})
	must(t, err)
	_, err = a.Send(ctx, "local-a", unrelated.Session, Content{Text: "independent progress"}, "local-send")
	must(t, err)
	close(releaseEnsure)
	must(t, <-results)
	must(t, <-results)
	if ctx.Err() != nil {
		t.Fatal("simultaneous remote ensures completed only at their deadlines")
	}
	go func() { _, err := a.Send(ctx, "remote-b", sA, Content{Text: "from A"}, "send-a"); results <- err }()
	go func() { _, err := b.Send(ctx, "remote-a", sB, Content{Text: "from B"}, "send-b"); results <- err }()
	waitRouting(t, entered)
	waitRouting(t, entered)
	close(releaseSend)
	must(t, <-results)
	must(t, <-results)
	if aBot.ensures != 2 || bBot.ensures != 1 || aBot.sends != 2 || bBot.sends != 1 {
		t.Fatal("remote commands did not execute exactly on the peer's default bot")
	}
}

func TestConcurrentSameSessionEnsureDeduplicatesWithoutBlockingOtherSessions(t *testing.T) {
	c := testCore(t, nil)
	base := installFake(t, c, "bot")
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var creates atomic.Int32
	bot := &routingTestBot{Bot: base}
	bot.ensure = func(ctx context.Context, s Session) (Binding, error) {
		creates.Add(1)
		if s.SessionID == "shared" {
			if err := barrierCall(ctx, entered, release); err != nil {
				return Binding{}, err
			}
		}
		return Binding{ProviderID: "bot", Session: s, ChatID: "group-" + s.SessionID}, nil
	}
	installRoutingBot(c, "bot", bot)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s := Session{Adapter: "codex", SessionID: "shared"}
	result := make(chan Binding, 2)
	failures := make(chan error, 2)
	go func() { b, err := c.Ensure(ctx, "bot", s); result <- b; failures <- err }()
	waitRouting(t, entered)
	go func() { b, err := c.Ensure(ctx, "bot", s); result <- b; failures <- err }()
	_, err := c.Ensure(ctx, "bot", Session{Adapter: "codex", SessionID: "different"})
	must(t, err)
	close(release)
	must(t, <-failures)
	must(t, <-failures)
	first, second := <-result, <-result
	if first.ChatID != second.ChatID || first.Created == second.Created || creates.Load() != 2 {
		t.Fatal("same-session creation was not serialized and reused")
	}
	c.sessions.mu.Lock()
	defer c.sessions.mu.Unlock()
	if len(c.sessions.entries) != 0 {
		t.Fatal("completed session gate was retained")
	}
}

func TestProviderRemovalDuringEnsureCannotPublishStaleBinding(t *testing.T) {
	c := testCore(t, nil)
	base := installFake(t, c, "bot")
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	bot := &routingTestBot{Bot: base}
	bot.ensure = func(ctx context.Context, s Session) (Binding, error) {
		if err := barrierCall(ctx, entered, release); err != nil {
			return Binding{}, err
		}
		return Binding{ProviderID: "bot", Session: s, ChatID: "created-during-removal"}, nil
	}
	installRoutingBot(c, "bot", bot)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s := Session{Adapter: "codex", SessionID: "raced"}
	result := make(chan error, 1)
	go func() { _, err := c.Ensure(ctx, "bot", s); result <- err }()
	waitRouting(t, entered)
	removed := make(chan error, 1)
	go func() { removed <- c.DeleteProvider("bot") }()
	select {
	case err := <-removed:
		must(t, err)
	case <-ctx.Done():
		t.Fatal("configuration deletion waited for a provider RPC")
	}
	close(release)
	if err := <-result; publicError(err).Code != "conflict" {
		t.Fatal("in-flight creation published a removed provider")
	}
	d := c.store.Snapshot()
	binding := d.Bindings[c.normalize(s).key()]
	if !binding.Deleted || len(d.RetiredBindings) != 1 {
		t.Fatal("stale created resource was not durably retired")
	}
}

func TestReplyPendingDuplicateAndUnrelatedSendProceedIndependently(t *testing.T) {
	c := testCore(t, nil)
	base := installFake(t, c, "bot")
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var replies atomic.Int32
	bot := &routingTestBot{Bot: base}
	bot.reply = func(ctx context.Context, m MessageRef, content Content, request string) (SendResult, error) {
		replies.Add(1)
		if err := barrierCall(ctx, entered, release); err != nil {
			return SendResult{}, err
		}
		return base.Reply(ctx, m, content, request)
	}
	installRoutingBot(c, "bot", bot)
	s := Session{Adapter: "codex", SessionID: "sender"}
	_, err := c.Ensure(context.Background(), "bot", s)
	must(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ref := MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: "incoming"}
	result := make(chan error, 1)
	go func() { _, err := c.Reply(ctx, ref, Content{Text: "reply"}, "stable"); result <- err }()
	waitRouting(t, entered)
	_, err = c.Reply(ctx, ref, Content{Text: "reply"}, "stable")
	if publicError(err).Code != "unconfirmed" || replies.Load() != 1 {
		t.Fatal("pending concurrent duplicate submitted another reply")
	}
	_, err = c.Send(ctx, "bot", s, Content{Text: "unrelated progress"}, "independent")
	must(t, err)
	close(release)
	must(t, <-result)
	_, err = c.Reply(ctx, ref, Content{Text: "reply"}, "stable")
	must(t, err)
	if replies.Load() != 1 {
		t.Fatal("successful reply lost its durable deduplication")
	}
}

func TestSiblingSubscriptionsShareOnePeerQueueWithoutEviction(t *testing.T) {
	c := testCore(t, nil)
	first, err := c.Subscribe(context.Background(), "peer", "first")
	must(t, err)
	defer first.Close()
	second, err := c.Subscribe(context.Background(), "peer", "second")
	must(t, err)
	defer second.Close()
	if first.ctx.Err() != nil || second.ctx.Err() != nil || peerStreams(c, "peer") != 2 {
		t.Fatal("sibling stream evicted a live subscription")
	}
	gotFirst := make(chan Event, 1)
	gotSecond := make(chan Event, 1)
	go func() { e, _ := first.Next(); gotFirst <- e }()
	go func() { e, _ := second.Next(); gotSecond <- e }()
	e := eventFor("elsewhere", "shared-node-copy")
	must(t, c.Ingest(context.Background(), e, ""))
	select {
	case got := <-gotFirst:
		if got.ID != e.ID {
			t.Fatal("first stream missed wake")
		}
	case <-time.After(time.Second):
		t.Fatal("first stream did not wake")
	}
	select {
	case got := <-gotSecond:
		if got.ID != e.ID {
			t.Fatal("second stream missed wake")
		}
	case <-time.After(time.Second):
		t.Fatal("second stream did not wake")
	}
	if len(c.store.Snapshot().Peers) != 1 || len(c.store.Snapshot().Peers["peer"].Pending) != 1 {
		t.Fatal("sibling stream allocated a second durable node queue")
	}
	must(t, first.Confirm(e.ID))
	if len(c.store.Snapshot().Peers["peer"].Pending) != 0 {
		t.Fatal("one stream's confirmation did not consume its node's copy")
	}
	must(t, second.Confirm(e.ID))
	canceled := make(chan error, 1)
	go func() { _, err := first.Next(); canceled <- err }()
	first.Close()
	select {
	case err := <-canceled:
		if err == nil {
			t.Fatal("closed stream was not canceled")
		}
	case <-time.After(time.Second):
		t.Fatal("closed stream did not unblock")
	}
	if second.ctx.Err() != nil || peerStreams(c, "peer") != 1 || !c.Status()["remote"].(RemoteSummary).Peers[0].Connected {
		t.Fatal("closing one stream disconnected its sibling")
	}
	e.ID = "only-survivor"
	e.Message.MessageID = e.ID
	must(t, c.Ingest(context.Background(), e, ""))
	got, err := second.Next()
	must(t, err)
	if got.ID != e.ID {
		t.Fatal("surviving sibling did not receive later broadcast")
	}
	c.Close()
	if second.ctx.Err() == nil {
		t.Fatal("core shutdown did not cancel all sibling streams")
	}
}

func TestTwoRemoteProvidersToSameUpstreamRemainConnectedAndExecuteOnce(t *testing.T) {
	upstream := testCore(t, nil)
	address, token := testServer(t, upstream)
	var deliveries atomic.Int32
	downstream := testCore(t, func(event string, _ any) error {
		if event == "delivery" {
			deliveries.Add(1)
		}
		return nil
	})
	one := addRemote(t, downstream, "route-one", address, token)
	two := addRemote(t, downstream, "route-two", address, token)
	await(t, func() bool { return peerStreams(upstream, downstream.node()) == 2 })
	e := eventFor(downstream.node(), "two-upstream-streams")
	must(t, upstream.Ingest(context.Background(), e, ""))
	await(t, func() bool {
		return deliveries.Load() == 1 && len(upstream.store.Snapshot().Peers[downstream.node()].Pending) == 0
	})
	if peerStreams(upstream, downstream.node()) != 2 {
		t.Fatal("duplicate upstream connections churned instead of staying live")
	}
	must(t, one.Close())
	await(t, func() bool { return peerStreams(upstream, downstream.node()) == 1 })
	e.ID = "surviving-route"
	e.Message.MessageID = e.ID
	must(t, upstream.Ingest(context.Background(), e, ""))
	await(t, func() bool { return deliveries.Load() == 2 })
	must(t, two.Close())
	await(t, func() bool { return peerStreams(upstream, downstream.node()) == 0 })
	if upstream.Status()["remote"].(RemoteSummary).Peers[0].Connected {
		t.Fatal("closed sibling streams left their peer connected")
	}
}

func TestUnhandledExpiredOrVisitedCopyCannotPoisonLaterValidRoute(t *testing.T) {
	for _, mode := range []string{"expired", "visited", "legacy-loop-record"} {
		for _, target := range []string{"local", "broadcast"} {
			t.Run(mode+"/"+target, func(t *testing.T) {
				var deliveries atomic.Int32
				c := testCore(t, func(name string, _ any) error {
					if name == "delivery" {
						deliveries.Add(1)
					}
					return nil
				})
				peer, err := c.Subscribe(context.Background(), "downstream", "")
				must(t, err)
				defer peer.Close()
				owner := c.node()
				if target == "broadcast" {
					owner = "another-owner"
				}
				good := eventFor(owner, mode+"-"+target)
				bad := good
				if mode == "visited" {
					bad.Visited = []string{c.node()}
				} else {
					bad.Hops = 0
				}
				if mode == "legacy-loop-record" {
					must(t, c.store.Update(func(d *State) error {
						d.Events[bad.ID] = EventRecord{Event: bad, Outcome: "loop_suppressed"}
						return nil
					}))
				} else {
					must(t, c.Ingest(context.Background(), bad, "long-route"))
					if _, exists := c.store.Snapshot().Events[bad.ID]; exists {
						t.Fatal("unhandled route reserved terminal event deduplication")
					}
				}
				must(t, c.Ingest(context.Background(), good, "short-route"))
				must(t, c.Ingest(context.Background(), good, "another-valid-route"))
				must(t, c.Ingest(context.Background(), bad, "loop-route"))
				d := c.store.Snapshot()
				if target == "local" {
					if deliveries.Load() != 1 || len(d.Deliveries) != 1 || d.Events[good.ID].Outcome != "local" {
						t.Fatal("later valid route did not deliver exactly once")
					}
				} else {
					if deliveries.Load() != 0 || len(d.Peers["downstream"].Pending) != 1 || d.Events[good.ID].Outcome != "broadcast" || d.BroadcastSequence != 1 {
						t.Fatal("later valid route did not broadcast exactly once")
					}
				}
				ref, err := c.Resolve(nil, good.Message.MessageID)
				must(t, err)
				if ref != good.Message || !contains(d.References[ref.key()].Routes, "short-route") {
					t.Fatal("route suppression changed the origin message reference or lost its valid return path")
				}
			})
		}
	}
}
