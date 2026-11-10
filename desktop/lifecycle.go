package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

const serviceControlTimeout = 155 * time.Second

func initialServiceAction(suppress, healthy, installed bool) string {
	if suppress || healthy {
		return ""
	}
	if installed {
		return "start"
	}
	return "install_service"
}

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
	service            controlledService
	controls           sync.Mutex
	locked             bool
	stopped            bool
	startAttempted     bool
	recoveryBlocked    bool
	wasRunning         bool
	replacementRunning bool
	guiPending         bool
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
	// Once the ownership-checked CLI starts stopping the service, let it finish
	// even if quit cancels the app: bootout can precede its shutdown-wait result.
	stopCtx, cancel := context.WithTimeout(context.Background(), serviceControlTimeout)
	defer cancel()
	var err error
	h.stopped, err = h.service.StopForUpdate(stopCtx)
	h.wasRunning = h.stopped
	// Keep the successful stop recorded for deferred recovery, but do not replace
	// the bundle when cancellation arrived during the critical stop.
	return errors.Join(err, ctx.Err())
}

// after runs against the newly exchanged bundle. A failed start may have loaded
// its job already; beforeRollback must quiesce it before resources move again.
func (h *serviceHandoff) after() error {
	if !h.stopped {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), serviceControlTimeout)
	defer cancel()
	h.startAttempted = true
	if err := h.service.Request(ctx, "start"); err != nil {
		return err
	}
	h.stopped = false
	h.startAttempted = false
	h.replacementRunning = true
	return nil
}

func (h *serviceHandoff) beforeRollback() error {
	if !h.startAttempted && !h.replacementRunning {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), serviceControlTimeout)
	defer cancel()
	var err error
	if stopper, ok := h.service.(interface{ QuiesceForRollback(context.Context) error }); ok {
		err = stopper.QuiesceForRollback(ctx)
	} else {
		_, err = h.service.StopForUpdate(ctx)
	}
	if err != nil {
		// Do not retry start or exchange/delete either bundle when the replacement
		// could still be running. The retained original is available for recovery.
		h.recoveryBlocked = true
		return err
	}
	h.startAttempted = false
	h.replacementRunning = false
	h.stopped = h.wasRunning
	return nil
}

func (h *serviceHandoff) releaseGUI() {
	if !h.guiPending {
		return
	}
	h.guiPending = false
	h.locked = false
	h.stopped = false
	h.wasRunning = false
	h.startAttempted = false
	h.replacementRunning = false
	h.recoveryBlocked = false
	h.controls.Unlock()
}

func (h *serviceHandoff) install(ctx context.Context, install func(context.Context) error) (err error) {
	defer func() {
		if err == nil && h.guiPending {
			return
		} // ownership transfers to post-loop GUI supervisor
		if h.locked {
			defer func() {
				h.locked = false
				h.stopped = false
				h.startAttempted = false
				h.recoveryBlocked = false
				h.wasRunning = false
				h.replacementRunning = false
				h.controls.Unlock()
			}()
		}
		// Cancellation after a successful stop is also a failed handoff. Never use
		// the cancelled application context to recover the independent service.
		if !h.recoveryBlocked {
			if recoveryErr := h.after(); recoveryErr != nil {
				err = errors.Join(err, fmt.Errorf("recover background service after update: %w", recoveryErr))
			}
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
