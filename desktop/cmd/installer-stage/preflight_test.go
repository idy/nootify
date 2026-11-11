package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDesktopPreflightNormalInstallDoesNotWait(t *testing.T) {
	busy := errors.New("synthetic busy desktop")
	for _, result := range []error{nil, busy} {
		calls := 0
		err := inspectDesktop(context.Background(), false, func(context.Context) error {
			calls++
			return result
		})
		if !errors.Is(err, result) || calls != 1 {
			t.Fatalf("normal preflight retried or lost its result: calls=%d err=%v", calls, err)
		}
	}
}

func TestDesktopPreflightUpdaterRetriesUntilHandoff(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	calls := 0
	err := inspectDesktop(ctx, true, func(probeContext context.Context) error {
		if probeContext != ctx {
			t.Fatal("a probe reset the shared deadline")
		}
		calls++
		if calls < 3 {
			return errors.New("synthetic desktop has not exited")
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("updater did not wait for handoff: calls=%d err=%v", calls, err)
	}
}

func TestDesktopPreflightCancellationIncludesInspection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	done := make(chan error, 1)
	calls := 0
	go func() {
		done <- inspectDesktop(ctx, true, func(probeContext context.Context) error {
			calls++
			close(entered)
			<-probeContext.Done()
			return probeContext.Err()
		})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("inspection never started")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || calls != 1 {
			t.Fatalf("canceled inspection was retried or accepted: calls=%d err=%v", calls, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the shared budget did not interrupt a running inspection")
	}
}

func TestDesktopPreflightRefusesExpiredOrLateInspection(t *testing.T) {
	expired, stop := context.WithDeadline(context.Background(), time.Unix(1, 0))
	defer stop()
	if err := inspectDesktop(expired, true, func(context.Context) error {
		t.Fatal("an expired handoff started another inspection")
		return nil
	}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("lost the handoff deadline:", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := inspectDesktop(ctx, true, func(context.Context) error {
		cancel()
		return nil
	}); !errors.Is(err, context.Canceled) {
		t.Fatal("accepted inspection success after its budget ended:", err)
	}
}
