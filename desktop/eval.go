package main

import (
	"context"
	"sync"
	"time"
)

// pageEvaluator preserves submission order without blocking the native UI thread.
// A single worker owns EvalContext until every queued script has completed.
type pageEvaluator struct {
	mu      sync.Mutex
	pending []string
	running bool
}

func (e *pageEvaluator) submit(ctx context.Context, source string, evaluate func(context.Context, string)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if ctx.Err() != nil {
		return
	}
	e.pending = append(e.pending, source)
	if e.running {
		return
	}
	e.running = true
	go e.run(ctx, evaluate)
}

func (e *pageEvaluator) run(ctx context.Context, evaluate func(context.Context, string)) {
	for {
		e.mu.Lock()
		if ctx.Err() != nil || len(e.pending) == 0 {
			e.pending = nil
			e.running = false
			e.mu.Unlock()
			return
		}
		source := e.pending[0]
		e.pending[0] = ""
		e.pending = e.pending[1:]
		e.mu.Unlock()
		callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		evaluate(callCtx, source)
		cancel()
	}
}
