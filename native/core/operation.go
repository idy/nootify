package main

import (
	"context"
	"errors"
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
