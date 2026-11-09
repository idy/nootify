package main

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestPageEvaluationsKeepSubmissionOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var queue pageEvaluator
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	var got []string
	evaluate := func(callCtx context.Context, source string) {
		if deadline, ok := callCtx.Deadline(); !ok || time.Until(deadline) > 2*time.Second {
			t.Error("page evaluation has no bounded context")
		}
		if source == "old language/update snapshot" {
			close(entered)
			<-release
		}
		got = append(got, source)
		if source == "settings navigation" {
			close(done)
		}
	}
	queue.submit(ctx, "old language/update snapshot", evaluate)
	awaitSignal(t, entered)
	queue.submit(ctx, "new language/update snapshot", evaluate)
	queue.submit(ctx, "settings navigation", evaluate)
	noSignal(t, done, "a newer evaluation overtook an in-flight snapshot")
	once.Do(func() { close(release) })
	awaitSignal(t, done)
	if !reflect.DeepEqual(got, []string{"old language/update snapshot", "new language/update snapshot", "settings navigation"}) {
		t.Fatal(got)
	}
}

func TestPageEvaluationsDiscardQueuedWorkOnQuit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var queue pageEvaluator
	entered, returned := make(chan struct{}), make(chan struct{})
	evaluate := func(callCtx context.Context, source string) {
		if source != "in flight" {
			t.Error("cancelled page evaluation executed", source)
			return
		}
		close(entered)
		<-callCtx.Done()
		close(returned)
	}
	queue.submit(ctx, "in flight", evaluate)
	awaitSignal(t, entered)
	queue.submit(ctx, "queued", evaluate)
	cancel()
	awaitSignal(t, returned)
	queue.submit(ctx, "after quit", evaluate)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		queue.mu.Lock()
		done := !queue.running && len(queue.pending) == 0
		queue.mu.Unlock()
		if done {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("cancelled evaluator retained pending scripts")
}
