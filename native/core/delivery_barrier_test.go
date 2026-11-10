package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestLocalDeliveryNeverDispatchesBeforeAdmissionBarrier(t *testing.T) {
	for _, phase := range []string{"admission", "pending"} {
		t.Run(phase, func(t *testing.T) {
			var emitted atomic.Int32
			c := testCore(t, func(name string, _ any) error {
				if name == "delivery" {
					emitted.Add(1)
				}
				return nil
			})
			var syncs atomic.Int32
			c.store.syncDirectory = func(string) error {
				n := syncs.Add(1)
				if phase == "admission" && n == 1 || phase == "pending" && n == 2 {
					return errors.New("synthetic barrier failure")
				}
				return nil
			}
			e := eventFor(c.node(), "barrier-"+phase)
			if err := c.Ingest(context.Background(), e, ""); publicError(err).Code != "committed_not_durable" {
				t.Fatalf("missing barrier warning: %v", err)
			}
			if emitted.Load() != 0 {
				t.Fatal("agent input escaped unconfirmed barrier")
			}
			id := ""
			for key, v := range c.store.Snapshot().Deliveries {
				id = key
				if v.Status != "retryable" {
					t.Fatalf("proven undispatched input stranded as %s", v.Status)
				}
			}
			c = reopenCore(t, c, func(name string, _ any) error {
				if name == "delivery" {
					emitted.Add(1)
				}
				return nil
			})
			if c.store.Snapshot().Deliveries[id].Status != "retryable" {
				t.Fatal("restart converted proven undispatched work into uncertainty")
			}
			must(t, c.RetryDeliveryContext(context.Background(), id))
			if emitted.Load() != 1 {
				t.Fatal("safe retry did not submit exactly once")
			}
		})
	}
}

func TestRetryPendingBarrierRepairsProofBeforeReturning(t *testing.T) {
	var emitted atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	})
	e := eventFor(c.node(), "retry-pending-barrier")
	must(t, c.Ingest(context.Background(), e, ""))
	id := ""
	for key := range c.store.Snapshot().Deliveries {
		id = key
	}
	must(t, c.Complete(id, "retryable", "offline", ""))
	var failed atomic.Bool
	c.store.syncDirectory = func(string) error {
		if !failed.Swap(true) {
			return errors.New("synthetic retry pending failure")
		}
		return nil
	}
	if err := c.RetryDeliveryContext(context.Background(), id); publicError(err).Code != "committed_not_durable" {
		t.Fatalf("missing retry barrier warning: %v", err)
	}
	if emitted.Load() != 1 || c.store.Snapshot().Deliveries[id].Status != "retryable" {
		t.Fatal("retry emitted without barrier or forgot proven non-submission")
	}
	c = reopenCore(t, c, func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	})
	must(t, c.RetryDeliveryContext(context.Background(), id))
	if emitted.Load() != 2 {
		t.Fatal("repaired retry did not resume exactly once")
	}
}

func TestRepeatedBarrierFailureKeepsPublishedDeliveryRetryable(t *testing.T) {
	var emitted atomic.Int32
	c := testCore(t, func(name string, _ any) error {
		if name == "delivery" {
			emitted.Add(1)
		}
		return nil
	})
	e := eventFor(c.node(), "repeated-barrier")
	must(t, c.Ingest(context.Background(), e, ""))
	id := ""
	for key := range c.store.Snapshot().Deliveries {
		id = key
	}
	must(t, c.Complete(id, "retryable", "offline", ""))
	c.store.syncDirectory = func(string) error { return errors.New("synthetic repeated barrier failure") }
	if err := c.RetryDeliveryContext(context.Background(), id); err == nil {
		t.Fatal("barrier error omitted")
	}
	if emitted.Load() != 1 || c.store.Snapshot().Deliveries[id].Status != "retryable" {
		t.Fatal("published repair did not preserve safe retry state")
	}
	c.store.syncDirectory = func(string) error { return nil }
	must(t, c.RetryDeliveryContext(context.Background(), id))
	if emitted.Load() != 2 {
		t.Fatal("delivery not retryable after filesystem recovery")
	}
}
