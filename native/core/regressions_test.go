package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func reopenCore(t *testing.T, c *Core, emit func(string, any) error) *Core {
	t.Helper()
	dir := c.store.dir
	c.Close()
	must(t, c.store.Close())
	store, err := OpenStore(dir)
	must(t, err)
	next, err := NewCore(context.Background(), store, emit)
	must(t, err)
	t.Cleanup(func() { next.Close(); store.Close() })
	return next
}

func TestFullPeerWindowDoesNotBlockHealthyBroadcastAndReplaysAfterRestart(t *testing.T) {
	c := testCore(t, nil)
	slow, err := c.Subscribe(context.Background(), "stalled", "")
	must(t, err)
	healthy, err := c.Subscribe(context.Background(), "healthy", "")
	must(t, err)
	// Model a previously subscribed peer whose entire send window was offered,
	// but never confirmed. The healthy peer confirmed those historical events.
	must(t, c.store.Update(func(d *State) error {
		peer := d.Peers["stalled"]
		for i := 0; i < maxPending; i++ {
			event := eventFor("elsewhere", fmt.Sprintf("old-%04d", i))
			event.Visited = []string{d.NodeID}
			d.BroadcastSequence++
			d.Events[event.ID] = EventRecord{Sequence: d.BroadcastSequence, Event: event, Outcome: "broadcast"}
			peer.Pending = append(peer.Pending, event.ID)
		}
		peer.Cursor = d.BroadcastSequence
		d.Peers[peer.NodeID] = peer
		other := d.Peers["healthy"]
		other.Cursor = d.BroadcastSequence
		d.Peers[other.NodeID] = other
		return nil
	}))
	const added = 4
	for i := 0; i < added; i++ {
		event := eventFor("elsewhere", fmt.Sprintf("new-%d", i))
		must(t, c.Ingest(context.Background(), event, ""))
		got, err := healthy.Next()
		must(t, err)
		if got.ID != event.ID {
			t.Fatal("healthy peer was blocked or received the wrong broadcast")
		}
		must(t, healthy.Confirm(got.ID))
	}
	d := c.store.Snapshot()
	log := broadcastLog(&d)
	if len(d.Peers["stalled"].Pending) != maxPending || pendingCount(d.Peers["stalled"], log) != maxPending+added {
		t.Fatal("full peer lost durable backlog or exceeded its window")
	}
	if pendingCount(d.Peers["healthy"], log) != 0 {
		t.Fatal("healthy confirmations were not independent")
	}
	slow.Close()
	healthy.Close()
	c = reopenCore(t, c, nil)
	slow, err = c.Subscribe(context.Background(), "stalled", "")
	must(t, err)
	defer slow.Close()
	first, err := slow.Next()
	must(t, err)
	if first.ID != "old-0000" {
		t.Fatal("restart did not replay unconfirmed historical event")
	}
	// Confirming four old events makes room for all four later broadcasts.
	for i := 0; i < added; i++ {
		must(t, slow.Confirm(fmt.Sprintf("old-%04d", i)))
	}
	d = c.store.Snapshot()
	if len(d.Peers["stalled"].Pending) != maxPending || d.Peers["stalled"].Cursor != d.BroadcastSequence {
		t.Fatal("confirmation did not refill the bounded window from durable backlog")
	}
	// The stream may already have offered the remaining old window. Verify it
	// can then emit every refilled event without re-confirming another peer.
	slow.mu.Lock()
	for _, id := range d.Peers["stalled"].Pending {
		if strings.HasPrefix(id, "old-") {
			slow.offered[id] = true
		}
	}
	slow.mu.Unlock()
	for i := 0; i < added; i++ {
		got, err := slow.Next()
		must(t, err)
		if got.ID != fmt.Sprintf("new-%d", i) {
			t.Fatal("catchup skipped or reordered admitted broadcast")
		}
		must(t, slow.Confirm(got.ID))
	}
	d = c.store.Snapshot()
	if pendingCount(d.Peers["healthy"], broadcastLog(&d)) != 0 {
		t.Fatal("lagging peer catchup changed healthy peer's confirmations")
	}
	newcomer, err := c.Subscribe(context.Background(), "new-peer", "")
	must(t, err)
	defer newcomer.Close()
	if len(c.store.Snapshot().Peers["new-peer"].Pending) != 0 {
		t.Fatal("new peer received events admitted before it subscribed")
	}
}

func TestProviderRemovalAllowsExplicitMoveAndSuppressesLateResources(t *testing.T) {
	delivered := 0
	emit := func(event string, _ any) error {
		if event == "delivery" {
			delivered++
		}
		return nil
	}
	c := testCore(t, emit)
	old := installFake(t, c, "removed")
	replacement := installFake(t, c, "replacement")
	s := Session{Adapter: "codex", SessionID: "moving", Metadata: map[string]any{"keep": "metadata"}}
	original, err := c.Ensure(context.Background(), "removed", s)
	must(t, err)
	must(t, c.DeleteProvider("removed"))
	if old.deletes != 0 {
		t.Fatal("removing provider unexpectedly called remote deletion")
	}
	automatic := context.WithValue(context.Background(), automaticKey{}, true)
	_, err = c.Ensure(automatic, "replacement", s)
	if publicError(err).Code != "deleted" {
		t.Fatal("automatic enrollment moved a removed-provider session")
	}
	moved, err := c.Ensure(context.Background(), "replacement", Session{Adapter: s.Adapter, SessionID: s.SessionID})
	must(t, err)
	if replacement.ensures != 1 || moved.ProviderID != "replacement" || moved.Session.Metadata["keep"] != "metadata" {
		t.Fatal("explicit move failed to preserve the session")
	}
	late := eventFor(c.node(), "late-old-group")
	late.Session = original.Session
	late.ChatID = original.ChatID
	late.Message = MessageRef{OriginNodeID: c.node(), ProviderID: "removed", MessageID: late.ID}
	must(t, c.Ingest(context.Background(), late, ""))
	if delivered != 0 || c.store.Snapshot().Events[late.ID].Outcome != "deleted" {
		t.Fatal("late event from a retired group executed after move")
	}
	current := late
	current.ID = "new-group-message"
	current.ChatID = moved.ChatID
	current.Message = MessageRef{OriginNodeID: c.node(), ProviderID: "replacement", MessageID: current.ID}
	must(t, c.Ingest(context.Background(), current, ""))
	if delivered != 1 {
		t.Fatal("new notification resource was suppressed")
	}
	c = reopenCore(t, c, emit)
	late.ID = "late-after-restart"
	late.Message.MessageID = late.ID
	must(t, c.Ingest(context.Background(), late, ""))
	if delivered != 1 {
		t.Fatal("retired-resource tombstone was lost on restart")
	}
}

func TestDeletionRecoveryDisabledFailureRetryAndExplicitMove(t *testing.T) {
	t.Run("upgrade existing deleted binding", func(t *testing.T) {
		c := testCore(t, nil)
		installFake(t, c, "bot")
		s := Session{NodeID: c.node(), Adapter: "codex", SessionID: "older-tombstone"}
		must(t, c.store.Update(func(d *State) error {
			d.Bindings[s.key()] = Binding{ProviderID: "bot", Session: s, ChatID: "old-group", Deleted: true}
			d.RetiredBindings = nil
			return nil
		}))
		c = reopenCore(t, c, nil)
		if len(c.store.Snapshot().RetiredBindings) != 1 {
			t.Fatal("older deleted binding did not gain a resource tombstone")
		}
	})
	t.Run("disabled then enabled", func(t *testing.T) {
		c := testCore(t, nil)
		p := installFake(t, c, "bot")
		s := Session{Adapter: "codex", SessionID: "disabled"}
		before, err := c.Ensure(context.Background(), "bot", s)
		must(t, err)
		c.mu.Lock()
		delete(c.providers, "bot")
		c.mu.Unlock()
		err = c.Delete(context.Background(), "", s)
		if publicError(err).Code != "unavailable" {
			t.Fatal("disabled cleanup was not reported")
		}
		_, err = c.Ensure(context.Background(), "", s)
		if publicError(err).Code != "unavailable" || p.ensures != 1 {
			t.Fatal("disabled provider created a replacement before cleanup")
		}
		c.mu.Lock()
		c.providers["bot"] = p
		c.mu.Unlock()
		after, err := c.Ensure(context.Background(), "", s)
		must(t, err)
		if p.deletes != 1 || p.ensures != 2 || before.ChatID == after.ChatID {
			t.Fatal("reenabling did not finish cleanup before reactivation")
		}
	})
	t.Run("uncertain failure then move", func(t *testing.T) {
		c := testCore(t, nil)
		old := installFake(t, c, "old")
		next := installFake(t, c, "new")
		s := Session{Adapter: "codex", SessionID: "failed"}
		_, err := c.Ensure(context.Background(), "old", s)
		must(t, err)
		old.deleteErr = context.DeadlineExceeded
		if c.Delete(context.Background(), "", s) == nil {
			t.Fatal("uncertain deletion unexpectedly succeeded")
		}
		_, err = c.Ensure(context.Background(), "new", s)
		if err == nil || next.ensures != 0 {
			t.Fatal("uncertain cleanup created a duplicate group")
		}
		old.deleteErr = nil
		b, err := c.Ensure(context.Background(), "new", s)
		must(t, err)
		if b.ProviderID != "new" || old.deletes != 3 || next.ensures != 1 || b.DeletePending {
			t.Fatal("explicit move did not retry and complete old cleanup")
		}
	})
	t.Run("delete retry", func(t *testing.T) {
		c := testCore(t, nil)
		p := installFake(t, c, "bot")
		s := Session{Adapter: "codex", SessionID: "retry"}
		_, err := c.Ensure(context.Background(), "", s)
		must(t, err)
		p.deleteErr = errors.New("temporary failure")
		if c.Delete(context.Background(), "", s) == nil {
			t.Fatal("cleanup error lost")
		}
		p.deleteErr = nil
		must(t, c.Delete(context.Background(), "", s))
		must(t, c.Delete(context.Background(), "", s))
		if p.deletes != 2 {
			t.Fatal("cleanup retry or deletion idempotency failed")
		}
		_, err = c.Ensure(context.Background(), "", s)
		must(t, err)
	})
	t.Run("retired resource never reused", func(t *testing.T) {
		c := testCore(t, nil)
		p := installFake(t, c, "bot")
		s := Session{Adapter: "codex", SessionID: "retired"}
		old, err := c.Ensure(context.Background(), "", s)
		must(t, err)
		must(t, c.Delete(context.Background(), "", s))
		p.ensure = func(context.Context, Session) (Binding, error) { return old, nil }
		_, err = c.Ensure(context.Background(), "", s)
		if publicError(err).Code != "conflict" || !c.store.Snapshot().Bindings[old.Session.key()].Deleted {
			t.Fatal("provider idempotency reactivated a retired group")
		}
	})
}

type adoptingBot struct {
	*fakeProvider
	binds int
}

func (p *adoptingBot) Bind(_ context.Context, s Session, chat, sender string) (Binding, error) {
	p.binds++
	return Binding{ProviderID: p.id, Session: s, ChatID: chat, SenderID: sender}, nil
}
func TestExplicitBindCannotBypassUncertainCleanupAndCanMoveAfterRemoval(t *testing.T) {
	c := testCore(t, nil)
	old := installFake(t, c, "old")
	next := &adoptingBot{fakeProvider: installFake(t, c, "new")}
	c.mu.Lock()
	c.providers["new"] = next
	c.mu.Unlock()
	s := Session{Adapter: "codex", SessionID: "bind-recovery"}
	original, err := c.Ensure(context.Background(), "old", s)
	must(t, err)
	old.deleteErr = context.DeadlineExceeded
	if c.Delete(context.Background(), "", s) == nil {
		t.Fatal("uncertain delete unexpectedly completed")
	}
	_, err = c.Bind(context.Background(), "new", s, "replacement-chat", "trusted")
	if err == nil || next.binds != 0 {
		t.Fatal("explicit bind bypassed uncertain old-provider cleanup")
	}
	must(t, c.DeleteProvider("old"))
	_, err = c.Bind(context.Background(), "new", s, original.ChatID, "trusted")
	if publicError(err).Code != "conflict" || next.binds != 0 {
		t.Fatal("explicit bind re-adopted retired resource")
	}
	b, err := c.Bind(context.Background(), "new", s, "replacement-chat", "trusted")
	must(t, err)
	if b.ProviderID != "new" || next.binds != 1 || b.Deleted || b.DeletePending {
		t.Fatal("explicit bind did not recover after provider removal")
	}
}

func TestReplyDefiniteRejectionCanRetryAndSuccessfulReplyDeduplicates(t *testing.T) {
	c := testCore(t, nil)
	p := installFake(t, c, "bot")
	ref := MessageRef{OriginNodeID: c.node(), ProviderID: "bot", MessageID: "incoming"}
	content := Content{Text: "same reply"}
	p.replyErr = &feishuAPIError{Code: 99991672, HTTPStatus: 403}
	_, err := c.Reply(context.Background(), ref, content, "stable")
	if publicError(err).Code != "rejection_retryable" {
		t.Fatal("permission rejection lost proven-safe status")
	}
	p.replyErr = nil
	first, err := c.Reply(context.Background(), ref, content, "stable")
	must(t, err)
	second, err := c.Reply(context.Background(), ref, content, "stable")
	must(t, err)
	if first.Message != second.Message || p.replies != 2 || p.requests[0] != p.requests[1] {
		t.Fatal("same request did not retry once and then deduplicate success")
	}
	p.replyErr = &feishuAPIError{Code: 230001, HTTPStatus: 400}
	_, err = c.Reply(context.Background(), ref, content, "terminal")
	if publicError(err).Code != "rejection_terminal" {
		t.Fatal("invalid request was not terminal")
	}
	p.replyErr = nil
	_, err = c.Reply(context.Background(), ref, content, "terminal")
	if publicError(err).Code != "rejection_terminal" || p.replies != 3 {
		t.Fatal("terminal explicit request was submitted again")
	}
}

func TestUncertainAutoSendSlotSurvivesRestartAndSuccessAllowsIdenticalSend(t *testing.T) {
	c := testCore(t, nil)
	p := installFake(t, c, "bot")
	s := Session{Adapter: "codex", SessionID: "auto"}
	_, err := c.Ensure(context.Background(), "", s)
	must(t, err)
	p.sendErr = fault("unavailable", "remote transport outcome unknown")
	_, err = c.Send(context.Background(), "", s, Content{Text: "uncertain"}, "")
	if publicError(err).Code != "unconfirmed" {
		t.Fatal("unknown remote failure was not marked uncertain")
	}
	if len(p.requests) != 1 || p.requests[0] == "" {
		t.Fatal("omitted request ID was not generated before provider submission")
	}
	generated := p.requests[0]
	d := c.store.Snapshot()
	if len(d.Operations) != 1 {
		t.Fatal("auto slot was not durably recorded")
	}
	for _, op := range d.Operations {
		if op.RequestID != generated || op.State != "unconfirmed" {
			t.Fatal("durable auto slot lost effective request ID or uncertainty")
		}
	}
	_, err = c.Send(context.Background(), "", s, Content{Text: "uncertain"}, "")
	if publicError(err).Code != "unconfirmed" || p.sends != 1 {
		t.Fatal("identical no-ID retry resubmitted unknown outcome")
	}
	c = reopenCore(t, c, nil)
	p = installFake(t, c, "bot")
	_, err = c.Send(context.Background(), "", s, Content{Text: "uncertain"}, "")
	if publicError(err).Code != "unconfirmed" || p.sends != 0 {
		t.Fatal("restart forgot uncertain auto-send slot")
	}
	first, err := c.Send(context.Background(), "", s, Content{Text: "intentional"}, "")
	must(t, err)
	second, err := c.Send(context.Background(), "", s, Content{Text: "intentional"}, "")
	must(t, err)
	if first.Message == second.Message || p.sends != 2 || p.requests[0] == p.requests[1] {
		t.Fatal("successful identical progress was incorrectly deduplicated")
	}
	if len(c.store.Snapshot().Operations) != 2 {
		t.Fatal("completed identical auto-send leaked new durable slots")
	}
}

func TestRetryableAutoSendReusesGeneratedIdentityAcrossRestart(t *testing.T) {
	c := testCore(t, nil)
	p := installFake(t, c, "bot")
	s := Session{Adapter: "codex", SessionID: "auto-retry"}
	_, err := c.Ensure(context.Background(), "", s)
	must(t, err)
	p.sendErr = &feishuAPIError{HTTPStatus: 429, Code: 99991400}
	_, err = c.Send(context.Background(), "", s, Content{Text: "rate limited"}, "")
	if publicError(err).Code != "rejection_retryable" {
		t.Fatal("rate limit was not a safe retry")
	}
	request := p.requests[0]
	c = reopenCore(t, c, nil)
	p = installFake(t, c, "bot")
	_, err = c.Send(context.Background(), "", s, Content{Text: "rate limited"}, "")
	must(t, err)
	if p.sends != 1 || p.requests[0] != request {
		t.Fatal("safe auto retry lost its generated request identity after restart")
	}
}

func TestDeadlineWhileQueuedNeverSubmitsOrPersistsAnIntent(t *testing.T) {
	c := testCore(t, nil)
	p := installFake(t, c, "bot")
	s := Session{Adapter: "codex", SessionID: "blocked"}
	_, err := c.Ensure(context.Background(), "", s)
	must(t, err)
	unlock, err := c.sessions.acquire(context.Background(), c.normalize(s).key())
	must(t, err)
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := c.Send(ctx, "", s, Content{Text: "expired"}, ""); result <- err }()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("wrong queued deadline result: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("expired request waited for the session gate")
	}
	unlock()
	locked = false
	if p.sends != 0 || len(c.store.Snapshot().Operations) != 0 {
		t.Fatal("expired queued request submitted or persisted a pending operation")
	}
}

func TestFeishuUnknownFailuresNeverBecomeSafeRejections(t *testing.T) {
	for _, err := range []error{context.DeadlineExceeded, &feishuAPIError{HTTPStatus: 502, Code: 99991672}, &feishuAPIError{HTTPStatus: 408, Code: 230002}, &feishuAPIError{HTTPStatus: 200, Code: 99999999}, &feishuAPIError{HTTPStatus: 200, Code: 230099}, &feishuAPIError{HTTPStatus: 200, Code: 12345}} {
		if _, proven := rejectionState(err); proven {
			t.Fatalf("uncertain failure was treated as non-acceptance: %v", err)
		}
	}
}

func TestProvenRejectionCodesRoundTripThroughRemoteReturnPath(t *testing.T) {
	upstream := testCore(t, nil)
	p := installFake(t, upstream, "bot")
	address, token := testServer(t, upstream)
	downstream := testCore(t, nil)
	addRemote(t, downstream, "upstream", address, token)
	ref := MessageRef{OriginNodeID: upstream.node(), ProviderID: "bot", MessageID: "incoming"}
	must(t, downstream.store.Update(func(d *State) error { remember(d, ref, "upstream"); return nil }))
	p.replyErr = &feishuAPIError{HTTPStatus: 403, Code: 99991672}
	_, err := downstream.Reply(context.Background(), ref, Content{Text: "reply"}, "stable-remote")
	if publicError(err).Code != "rejection_retryable" {
		t.Fatal("gRPC relay lost definite rejection proof")
	}
	p.replyErr = nil
	first, err := downstream.Reply(context.Background(), ref, Content{Text: "reply"}, "stable-remote")
	must(t, err)
	again, err := downstream.Reply(context.Background(), ref, Content{Text: "reply"}, "stable-remote")
	must(t, err)
	if first.Message != again.Message || p.replies != 2 {
		t.Fatal("remote rejection recovery repeated a successful reply")
	}
	// An arbitrary unavailable code remains uncertain even if transmitted by a
	// well-authenticated peer. Only the two explicit rejection codes are proof.
	raw, _ := json.Marshal(downstream.store.Snapshot().Operations)
	if strings.Contains(string(raw), "pending\"") {
		t.Fatal("completed remote request retained a pending state")
	}
}
