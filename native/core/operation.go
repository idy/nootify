package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

// operationGate preserves serialization while allowing an expired request to
// leave the queue without ever persisting an intent or invoking a provider.
type operationGate struct{ token chan struct{} }

func newOperationGate() *operationGate { return &operationGate{token: make(chan struct{}, 1)} }
func (g *operationGate) Lock()         { _ = g.LockContext(context.Background()) }
func (g *operationGate) Unlock()       { <-g.token }
func (g *operationGate) LockContext(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case g.token <- struct{}{}:
	}
	if err := ctx.Err(); err != nil {
		g.Unlock()
		return err
	}
	return nil
}

// Session gates serialize only one full session identity. References include
// waiters so a canceled waiter cannot remove a gate still held by another RPC.
// Entries disappear after the final holder/waiter leaves.
type sessionGates struct {
	mu      sync.Mutex
	entries map[string]*sessionGateEntry
}
type sessionGateEntry struct {
	gate *operationGate
	refs int
}

func (g *sessionGates) acquire(ctx context.Context, key string) (func(), error) {
	g.mu.Lock()
	if g.entries == nil {
		g.entries = map[string]*sessionGateEntry{}
	}
	entry := g.entries[key]
	if entry == nil {
		entry = &sessionGateEntry{gate: newOperationGate()}
		g.entries[key] = entry
	}
	entry.refs++
	g.mu.Unlock()
	unref := func() {
		g.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(g.entries, key)
		}
		g.mu.Unlock()
	}
	if err := entry.gate.LockContext(ctx); err != nil {
		unref()
		return nil, err
	}
	return func() { entry.gate.Unlock(); unref() }, nil
}

// Admission is serialized only until its durable pending intent is saved.
// Concurrent duplicates then see pending and cannot submit a second RPC. The
// provider call and outcome persistence never hold the node-wide gate.
func (c *Core) admitOperation(ctx context.Context, key, request, finger string, automatic bool) (string, *SendResult, error) {
	if err := c.ops.LockContext(ctx); err != nil {
		return request, nil, err
	}
	defer c.ops.Unlock()
	if key == "" {
		return request, nil, nil
	}
	if previous, exists := c.store.Snapshot().Operations[key]; exists {
		if previous.Fingerprint != finger {
			return request, nil, fault("conflict", "request ID was used for a different operation")
		}
		switch previous.State {
		case "complete":
			if !automatic {
				var result SendResult
				if err := json.Unmarshal(previous.Result, &result); err != nil {
					return request, nil, err
				}
				return request, &result, nil
			}
		case "terminal":
			if !automatic {
				if previous.Failure != nil {
					return request, nil, decodeOperationError(previous.Failure.Code, previous.Failure.Message)
				}
				return request, nil, rejectOperation(false, "request was definitively rejected")
			}
		case "retryable":
			request = previous.RequestID
		default:
			return request, nil, fault("unconfirmed", "previous send may have succeeded; automatic retry is unsafe")
		}
	}
	if automatic && request == "" {
		request = uid()
	}
	if err := ctx.Err(); err != nil {
		return request, nil, err
	}
	err := c.store.Update(func(d *State) error {
		d.Operations[key] = Operation{State: "pending", Fingerprint: finger, RequestID: request}
		return nil
	})
	return request, nil, err
}

// A rejection is evidence that the provider did not accept a side effect.
// It must never be inferred from an arbitrary transport error or timeout.
type operationRejection struct {
	Retryable bool
	Message   string
}

func (e *operationRejection) Error() string { return e.Message }
func rejectOperation(retryable bool, message string) error {
	return &operationRejection{Retryable: retryable, Message: message}
}
func rejectionState(err error) (string, bool) {
	var rejection *operationRejection
	if errors.As(err, &rejection) {
		if rejection.Retryable {
			return "retryable", true
		}
		return "terminal", true
	}
	var api *feishuAPIError
	if errors.As(err, &api) {
		return api.rejectionState()
	}
	return "", false
}

// decodeOperationError is also used by remote providers so non-acceptance proof
// survives a relay. Unknown codes retain their ordinary RPC error semantics.
func decodeOperationError(code, message string) error {
	switch code {
	case "rejection_retryable":
		return rejectOperation(true, message)
	case "rejection_terminal":
		return rejectOperation(false, message)
	}
	return fault(code, message)
}
func rejectionPublicError(err error) (*rpcError, bool) {
	state, ok := rejectionState(err)
	if !ok {
		return nil, false
	}
	code := "rejection_terminal"
	if state == "retryable" {
		code = "rejection_retryable"
	}
	return &rpcError{Code: code, Message: err.Error()}, true
}
