package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOperationAdmissionBarrierFailureRepairsProofAcrossRestart(t *testing.T) {
	for _, repairWarns := range []bool{false, true} {
		t.Run(map[bool]string{false: "repair-durable", true: "repair-warning"}[repairWarns], func(t *testing.T) {
			c := testCore(t, nil)
			calls, barriers := 0, 0
			cause := errors.New("synthetic pending admission barrier failure")
			c.store.syncDirectory = func(string) error {
				barriers++
				if barriers == 2 || repairWarns && barriers == 3 {
					return cause
				}
				return nil
			}
			result := SendResult{Message: MessageRef{OriginNodeID: "synthetic", ProviderID: "synthetic", MessageID: "result"}, MessageID: "result"}
			invoke := func() (SendResult, error) {
				return c.operation(context.Background(), "admission-key", "stable-request", "stable-input", false, func(request string) (SendResult, error) {
					calls++
					if request != "stable-request" {
						t.Fatal("repair changed the provider deduplication request ID")
					}
					return result, nil
				})
			}
			_, err := invoke()
			if err == nil || calls != 0 || c.store.Snapshot().Operations["admission-key"].State != "retryable" {
				t.Fatalf("failed barrier lost pre-dispatch proof: calls=%d err=%v", calls, err)
			}
			wantCode := "rejection_retryable"
			if repairWarns {
				wantCode = "committed_not_durable"
			}
			if publicError(err).Code != wantCode {
				t.Fatalf("inaccurate pre-dispatch outcome code: got %s want %s", publicError(err).Code, wantCode)
			}
			// Reopen directly from the repaired replacement; do not rely on an
			// unrelated successful write to make the proof survive this restart.
			c = reopenCore(t, c, nil)
			got, err := invoke()
			must(t, err)
			if calls != 1 || got.MessageID != result.MessageID {
				t.Fatal("restart did not safely retry the proven undispatched operation")
			}
			_, err = invoke()
			must(t, err)
			if calls != 1 {
				t.Fatal("completed retry was submitted twice")
			}
		})
	}
}

func TestOperationAdmissionSendAndReplyProofSurvivesPersistentWarningRestart(t *testing.T) {
	for _, mode := range []string{"explicit-send", "automatic-send", "reply"} {
		t.Run(mode, func(t *testing.T) {
			c := testCore(t, nil)
			provider := installFake(t, c, "synthetic-provider")
			session := Session{Adapter: "synthetic", SessionID: "admission-session"}
			_, err := c.Ensure(context.Background(), "synthetic-provider", session)
			must(t, err)
			reference := MessageRef{OriginNodeID: c.node(), ProviderID: "synthetic-provider", MessageID: "reply-target", ThreadID: "thread"}
			must(t, c.store.Update(func(d *State) error { remember(d, reference, ""); return nil }))
			invoke := func() (SendResult, error) {
				switch mode {
				case "explicit-send":
					return c.Send(context.Background(), "synthetic-provider", session, Content{Text: "same input"}, "same-request")
				case "automatic-send":
					return c.Send(context.Background(), "synthetic-provider", session, Content{Text: "same input"}, "")
				default:
					return c.Reply(context.Background(), reference, Content{Text: "same reply"}, "same-request")
				}
			}
			barriers := 0
			c.store.syncDirectory = func(string) error {
				barriers++
				if barriers >= 2 {
					return errors.New("synthetic persistent directory barrier failure")
				}
				return nil
			}
			_, err = invoke()
			if err == nil || publicError(err).Code != "committed_not_durable" {
				t.Fatalf("lost persistent repair durability warning: %v", err)
			}
			provider.mu.Lock()
			calls := provider.sends + provider.replies
			provider.mu.Unlock()
			if calls != 0 {
				t.Fatal("provider ran before pending admission durability was confirmed")
			}
			var requestID string
			for _, operation := range c.store.Snapshot().Operations {
				if operation.State != "retryable" || operation.RequestID == "" {
					t.Fatal("persistent barrier warning did not leave a safe pre-dispatch marker")
				}
				requestID = operation.RequestID
			}
			c = reopenCore(t, c, nil)
			provider = installFake(t, c, "synthetic-provider")
			_, err = invoke()
			must(t, err)
			provider.mu.Lock()
			if provider.sends+provider.replies != 1 || len(provider.requests) != 1 || provider.requests[0] != requestID {
				provider.mu.Unlock()
				t.Fatal("restart changed the admitted provider request ID or submitted more than once")
			}
			provider.mu.Unlock()
			if mode != "automatic-send" {
				_, err = invoke()
				must(t, err)
				provider.mu.Lock()
				if provider.sends+provider.replies != 1 {
					provider.mu.Unlock()
					t.Fatal("same explicit request was resubmitted after successful completion")
				}
				provider.mu.Unlock()
			}
		})
	}
}

func TestOperationAdmissionRetainsLiveProofWhenRepairWriteFails(t *testing.T) {
	c := testCore(t, nil)
	path := filepath.Join(c.store.dir, "state.json")
	backup := filepath.Join(c.store.dir, "synthetic-pending-backup")
	cause := errors.New("synthetic admission barrier and repair replacement failure")
	calls, barriers := 0, 0
	c.store.syncDirectory = func(string) error {
		barriers++
		if barriers == 2 {
			must(t, os.Rename(path, backup))
			must(t, os.Mkdir(path, 0700)) // Repair cannot replace a directory.
			return cause
		}
		return nil
	}
	invoke := func() error {
		_, err := c.operation(context.Background(), "repair-key", "stable", "input", false, func(string) (SendResult, error) {
			calls++
			return SendResult{Message: MessageRef{OriginNodeID: "fixture", ProviderID: "fixture", MessageID: "sent"}}, nil
		})
		return err
	}
	if err := invoke(); err == nil || calls != 0 || c.store.Snapshot().Operations["repair-key"].State != "pending" {
		t.Fatalf("fixture did not preserve failed repair conservatively: %v", err)
	}
	if err := invoke(); err == nil || calls != 0 {
		t.Fatal("unpersisted proof authorized a provider call")
	}
	must(t, os.Remove(path))
	must(t, os.Rename(backup, path))
	c.store.syncDirectory = syncStateDirectory
	must(t, invoke()) // Admission flushes its exact repair before checking state.
	if calls != 1 || len(c.store.undispatched) != 0 {
		t.Fatal("storage recovery did not flush and safely use retained no-submission proof")
	}
}

func TestOperationAdmissionNeverRepairsAnActualUnconfirmedSubmission(t *testing.T) {
	c := testCore(t, nil)
	calls := 0
	invoke := func() error {
		_, err := c.operation(context.Background(), "actually-submitted", "request", "input", false, func(string) (SendResult, error) {
			calls++
			return SendResult{}, errors.New("synthetic lost provider response")
		})
		return err
	}
	if err := invoke(); err == nil || publicError(err).Code != "unconfirmed" || calls != 1 {
		t.Fatal("fixture did not record an actually attempted uncertain submission")
	}
	c = reopenCore(t, c, nil)
	if err := invoke(); err == nil || publicError(err).Code != "unconfirmed" || calls != 1 {
		t.Fatal("restart mistook an actually uncertain submission for safe pre-dispatch proof")
	}
}

func TestStoreUndispatchedRepairWarningDoesNotCommitNextMutation(t *testing.T) {
	s, _ := retentionStore(t)
	must(t, s.Update(func(d *State) error { d.Operations["pending"] = Operation{State: "pending"}; return nil }))
	path, backup := filepath.Join(s.dir, "state.json"), filepath.Join(s.dir, "synthetic-pending-state")
	must(t, os.Rename(path, backup))
	must(t, os.Mkdir(path, 0700))
	if err := s.RepairUndispatched("operation:pending", func(d *State) error {
		op := d.Operations["pending"]
		if op.State == "pending" {
			op.State = "retryable"
			d.Operations["pending"] = op
		}
		return nil
	}); err == nil {
		t.Fatal("fixture did not retain a failed repair")
	}
	must(t, os.Remove(path))
	must(t, os.Rename(backup, path))
	cause := errors.New("synthetic queued repair durability warning")
	s.syncDirectory = func(string) error { return cause }
	ran := false
	err := s.Update(func(d *State) error { ran = true; d.DefaultProvider = "must-not-publish"; return nil })
	if err == nil || ran || stateCommitted(err) || !errors.Is(err, cause) || publicError(err).Code != "rejection_retryable" {
		t.Fatalf("another repair's commit was attributed to an unapplied mutation: %v", err)
	}
	if s.Snapshot().DefaultProvider != "" || s.Snapshot().Operations["pending"].State != "retryable" {
		t.Fatal("queued repair corrupted the requested mutation's publication state")
	}
	s.syncDirectory = syncStateDirectory
	must(t, s.Sync())
	must(t, s.Update(func(d *State) error { d.Operations["pending"] = Operation{State: "pending"}; return nil }))
	must(t, s.Sync())
	if s.Snapshot().Operations["pending"].State != "pending" {
		t.Fatal("completed repair was reapplied over a later admitted submission")
	}
}

func TestStoreUndispatchedRepairFlushesBeforeWriteSyncAndClose(t *testing.T) {
	for _, flush := range []string{"update", "sync", "close"} {
		t.Run(flush, func(t *testing.T) {
			s, _ := retentionStore(t)
			must(t, s.Update(func(d *State) error { d.Operations["pending"] = Operation{State: "pending"}; return nil }))
			path := filepath.Join(s.dir, "state.json")
			backup := filepath.Join(s.dir, "synthetic-proof-backup")
			must(t, os.Rename(path, backup))
			must(t, os.Mkdir(path, 0700))
			err := s.RepairUndispatched("operation:pending", func(d *State) error {
				op := d.Operations["pending"]
				if op.State == "pending" {
					op.State = "retryable"
					d.Operations["pending"] = op
				}
				return nil
			})
			if err == nil || len(s.undispatched) != 1 || s.Snapshot().Operations["pending"].State != "pending" {
				t.Fatal("failed repair was lost or falsely published")
			}
			must(t, os.Remove(path))
			must(t, os.Rename(backup, path))
			switch flush {
			case "update":
				must(t, s.Update(func(d *State) error {
					if d.Operations["pending"].State != "retryable" {
						t.Fatal("new mutation ran before the no-submission repair")
					}
					return nil
				}))
			case "sync":
				must(t, s.Sync())
			case "close":
				must(t, s.Close())
			}
			if flush != "close" {
				must(t, s.Close())
			}
			reopened, err := OpenStore(s.dir)
			must(t, err)
			t.Cleanup(func() { _ = reopened.Close() })
			if reopened.Snapshot().Operations["pending"].State != "retryable" {
				t.Fatal("flushed no-submission proof did not survive restart")
			}
		})
	}
}
