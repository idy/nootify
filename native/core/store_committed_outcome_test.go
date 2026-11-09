package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

func TestStoreCommittedSyncFailurePublishesAndReopens(t *testing.T) {
	for _, barrier := range []string{"open directory", "sync directory", "close directory"} {
		t.Run(barrier, func(t *testing.T) {
			s, _ := retentionStore(t)
			cause := fmt.Errorf("synthetic %s failure", barrier)
			mutations := 0
			s.syncDirectory = func(string) error { return cause }
			err := s.Update(func(d *State) error {
				mutations++
				d.DefaultProvider = "new-committed-provider"
				return nil
			})
			var committed *committedStateError
			if err == nil || !stateCommitted(err) || !errors.As(err, &committed) || !errors.Is(err, cause) {
				t.Fatalf("post-rename error was not an explicit committed outcome: %v", err)
			}
			if publicError(err).Code != "committed_not_durable" {
				t.Fatalf("committed outcome became retryable unavailable: %+v", publicError(err))
			}
			if s.Snapshot().DefaultProvider != "new-committed-provider" {
				t.Fatal("committed state not visible in memory")
			}
			before, readErr := os.ReadFile(filepath.Join(s.dir, "state.json"))
			must(t, readErr)
			if !bytes.Contains(before, []byte("new-committed-provider")) {
				t.Fatal("memory and replacement file disagree")
			}
			if retryErr := s.Sync(); !stateCommitted(retryErr) || !errors.Is(retryErr, cause) {
				t.Fatalf("failed barrier retry lost committed outcome: %v", retryErr)
			}
			s.syncDirectory = syncStateDirectory
			must(t, s.Sync())
			after, readErr := os.ReadFile(filepath.Join(s.dir, "state.json"))
			must(t, readErr)
			if mutations != 1 || !bytes.Equal(before, after) {
				t.Fatal("durability retry reran or changed the business mutation")
			}
			must(t, s.Close())
			reopened, openErr := OpenStore(s.dir)
			must(t, openErr)
			t.Cleanup(func() { _ = reopened.Close() })
			if reopened.Snapshot().DefaultProvider != "new-committed-provider" {
				t.Fatal("ordinary restart did not observe the committed replacement")
			}
		})
	}
}

func TestStoreCommittedOperationOutcomeNeverResubmits(t *testing.T) {
	for _, phase := range []string{"pending", "complete"} {
		t.Run(phase, func(t *testing.T) {
			c := testCore(t, nil)
			calls, barriers := 0, 0
			cause := errors.New("synthetic operation durability failure")
			c.store.syncDirectory = func(string) error {
				barriers++
				if phase == "pending" || barriers == 2 {
					return cause
				}
				return nil
			}
			result := SendResult{Message: MessageRef{OriginNodeID: "synthetic", ProviderID: "synthetic", MessageID: "known-result"}, MessageID: "known-result"}
			invoke := func() (SendResult, error) {
				return c.operation(context.Background(), "synthetic-key", "request", "synthetic-input", false, func(string) (SendResult, error) {
					calls++
					return result, nil
				})
			}
			_, err := invoke()
			if err == nil || !stateCommitted(err) || publicError(err).Code != "committed_not_durable" {
				t.Fatalf("lost committed operation warning: %v", err)
			}
			c.store.syncDirectory = syncStateDirectory
			must(t, c.store.Sync())
			got, retryErr := invoke()
			if phase == "pending" {
				if calls != 0 || retryErr == nil || publicError(retryErr).Code != "unconfirmed" {
					t.Fatal("non-durable pending intent was automatically submitted")
				}
			} else if calls != 1 || retryErr != nil || got.MessageID != result.MessageID {
				t.Fatalf("committed known result was resubmitted or lost: calls=%d result=%+v error=%v", calls, got, retryErr)
			}
		})
	}
}

func TestStoreDurableSnapshotBlocksPeerPublicationUntilBarrierRecovers(t *testing.T) {
	c := testCore(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub, err := c.Subscribe(ctx, "synthetic-peer", "")
	must(t, err)
	defer sub.Close()
	cause := errors.New("synthetic origin directory barrier failure")
	c.store.syncDirectory = func(string) error { return cause }
	event := eventFor("synthetic-peer", "durability-before-publication")
	event.Session.Adapter = "trae"
	event.Message.OriginNodeID = c.node()
	if err := c.Ingest(ctx, event, ""); err == nil || !stateCommitted(err) {
		t.Fatalf("fixture did not commit with a durability warning: %v", err)
	}
	if _, exists := c.store.Snapshot().Events[event.ID]; !exists {
		t.Fatal("committed event disappeared from the live state")
	}
	if _, err := sub.Next(); err == nil || !errors.Is(err, cause) {
		t.Fatalf("peer observed an event before its origin hold was durable: %v", err)
	}
	c.store.syncDirectory = syncStateDirectory
	got, err := sub.Next() // Retries only the directory barrier, then snapshots.
	must(t, err)
	if got.ID != event.ID || c.store.Snapshot().References[event.Message.key()].InboxState != "pending" {
		t.Fatal("barrier recovery lost the event or its canonical pending hold")
	}
	must(t, sub.Confirm(got.ID))
}

func TestStorePreRenameFailureDoesNotPublish(t *testing.T) {
	s, _ := retentionStore(t)
	before := s.Snapshot()
	path := filepath.Join(s.dir, "state.json")
	must(t, os.Remove(path))
	must(t, os.Mkdir(path, 0700)) // Force atomic replacement to fail.
	err := s.Update(func(d *State) error { d.DefaultProvider = "uncommitted"; return nil })
	if err == nil || stateCommitted(err) || s.Snapshot().DefaultProvider != before.DefaultProvider {
		t.Fatalf("failed rename published a mutation: %v", err)
	}
	entries, err := os.ReadDir(s.dir)
	must(t, err)
	for _, entry := range entries {
		if len(entry.Name()) >= 7 && entry.Name()[:7] == ".state-" {
			t.Fatal("failed transaction left its temporary state file")
		}
	}
}

func TestStoreConcurrentCommitWarningsAndBarrierRetries(t *testing.T) {
	s, _ := retentionStore(t)
	var barriers atomic.Int64
	cause := errors.New("synthetic intermittent directory sync failure")
	s.syncDirectory = func(string) error {
		if barriers.Add(1)%2 == 0 {
			return cause
		}
		return nil
	}
	const writers = 4
	const writes = 8
	var group sync.WaitGroup
	failures := make(chan error, writers*2)
	for i := 0; i < writers; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for j := 0; j < writes; j++ {
				err := s.Update(func(d *State) error { d.BroadcastSequence++; return nil })
				if !stateCommitted(err) || (err != nil && !errors.Is(err, cause)) {
					failures <- fmt.Errorf("unexpected update outcome: %v", err)
					return
				}
				if err := s.Sync(); !stateCommitted(err) {
					failures <- err
					return
				}
				_ = s.Snapshot()
			}
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if s.Snapshot().BroadcastSequence != writers*writes {
		t.Fatal("concurrent barrier retry reran or lost a committed mutation")
	}
}
