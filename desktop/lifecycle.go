package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

const serviceRecoveryTimeout = 155 * time.Second

type controlledService interface {
	Install(context.Context) error
	Request(context.Context, string) error
	StopForUpdate(context.Context) (bool, error)
}

// serviceHandoff serializes controls at execution time, including requests queued
// before an update. Only the update worker calls install and its before/after hooks.
// Download and validation stay outside controls; replacement, rollback and recovery
// retain it until install returns. The CLI still makes all ownership decisions.
type serviceHandoff struct {
	service  controlledService
	controls sync.Mutex
	locked   bool
	stopped  bool
}

func (h *serviceHandoff) action(ctx context.Context, action string) error {
	h.controls.Lock()
	defer h.controls.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if action == "install_service" {
		return h.service.Install(ctx)
	}
	return h.service.Request(ctx, action)
}

func (h *serviceHandoff) before(ctx context.Context) error {
	h.controls.Lock()
	h.locked = true
	if err := ctx.Err(); err != nil {
		return err
	}
	var err error
	h.stopped, err = h.service.StopForUpdate(ctx)
	return err
}

// after runs against the newly exchanged bundle. If starting it fails, the updater
// rolls back before install's deferred recovery retries against the original bundle.
func (h *serviceHandoff) after() error {
	if !h.stopped {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), serviceRecoveryTimeout)
	defer cancel()
	if err := h.service.Request(ctx, "start"); err != nil {
		return err
	}
	h.stopped = false
	return nil
}

func (h *serviceHandoff) install(ctx context.Context, install func(context.Context) error) (err error) {
	defer func() {
		if h.locked {
			defer func() {
				h.locked = false
				h.stopped = false
				h.controls.Unlock()
			}()
		}
		// Cancellation after a successful stop is also a failed handoff. Never use
		// the cancelled application context to recover the independent service.
		if recoveryErr := h.after(); recoveryErr != nil {
			err = errors.Join(err, fmt.Errorf("recover background service after update: %w", recoveryErr))
		}
	}()
	return install(ctx)
}

// runUpdateRequests returns true only after a complete successful install, so the
// host can mark the worker finished before asking the native app to relaunch/quit.
func runUpdateRequests(ctx context.Context, requests <-chan string, check, install func(context.Context) error, report func(error)) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case action := <-requests:
			// A cancelled select can choose an already queued request.
			if ctx.Err() != nil {
				return false
			}
			var err error
			if action == "check_update" {
				err = check(ctx)
			} else {
				err = install(ctx)
				if err == nil {
					return ctx.Err() == nil
				}
			}
			if err != nil {
				// A recovery failure may wrap context.Canceled as well as the actual
				// restart error, so cancellation must not suppress error reporting.
				report(err)
			}
		}
	}
}

// updateShutdown is accessed on the UI thread. Deferring quit keeps that event loop
// available to the worker's synchronous UI callbacks while it cancels and recovers.
type updateShutdown struct {
	done    <-chan struct{}
	waiting bool
}

func (q *updateShutdown) deferQuit(cancel context.CancelFunc, resume func()) bool {
	if q.done == nil {
		return false
	}
	select {
	case <-q.done:
		return false
	default:
	}
	if !q.waiting {
		q.waiting = true
		cancel()
		go func() {
			<-q.done
			resume()
		}()
	}
	return true
}
