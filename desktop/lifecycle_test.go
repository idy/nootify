package main

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// All lifecycle operations are injected: these tests never initialize MyGo, run
// the installed CLI, contact production health, or invoke a service manager.
type fakeControlledService struct {
	install func(context.Context) error
	request func(context.Context, string) error
	stop    func(context.Context) (bool, error)
}

func (f fakeControlledService) Install(ctx context.Context) error { return f.install(ctx) }
func (f fakeControlledService) Request(ctx context.Context, action string) error {
	return f.request(ctx, action)
}
func (f fakeControlledService) StopForUpdate(ctx context.Context) (bool, error) {
	return f.stop(ctx)
}

func awaitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("lifecycle operation did not finish")
	}
}

func noSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
		t.Fatal(message)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestServiceControlsWaitForUpdateRecovery(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		name := "success"
		if rollback {
			name = "rollback"
		}
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var events []string
			record := func(event string) { mu.Lock(); defer mu.Unlock(); events = append(events, event) }
			var bundle atomic.Int32
			bundle.Store(1)
			var running atomic.Int32
			running.Store(1)
			stopped, exchanged, restarting := make(chan struct{}), make(chan struct{}), make(chan struct{})
			replace, restart := make(chan struct{}), make(chan struct{})
			t.Cleanup(func() { // Release every injected hook even after a failed assertion.
				select {
				case <-replace:
				default:
					close(replace)
				}
				select {
				case <-restart:
				default:
					close(restart)
				}
			})
			type queuedAction struct{}
			fake := fakeControlledService{
				stop: func(context.Context) (bool, error) {
					running.Store(0)
					record("stop")
					close(stopped)
					return true, nil
				},
				request: func(ctx context.Context, action string) error {
					if ctx.Value(queuedAction{}) != nil {
						record("queued " + action)
					} else {
						if bundle.Load() == 2 {
							record("start new")
							close(restarting)
							<-restart
							if rollback {
								return errors.New("new service start failed")
							}
						} else {
							record("recover original")
						}
					}
					running.Store(bundle.Load())
					return nil
				},
				install: func(context.Context) error { record("queued install"); return nil },
			}
			h := &serviceHandoff{service: fake}
			// Queue controls before the update starts, then let the worker dequeue
			// them while the service is stopped. No click-handler gate can pass this.
			requests := make(chan string, 3)
			for _, action := range []string{"start", "restart", "install_service"} {
				requests <- action
			}
			close(requests)
			installed := make(chan error, 1)
			go func() {
				installed <- h.install(context.Background(), func(ctx context.Context) error {
					if err := h.before(ctx); err != nil {
						return err
					}
					<-replace
					if running.Load() != 0 {
						return errors.New("pre-update daemon survived the stop")
					}
					bundle.Store(2)
					record("exchange")
					close(exchanged)
					if err := h.after(); err != nil {
						bundle.Store(1)
						record("rollback")
						return err
					}
					return nil
				})
			}()
			awaitSignal(t, stopped)
			attempted, actionsDone := make(chan struct{}), make(chan struct{})
			go func() {
				defer close(actionsDone)
				close(attempted)
				for action := range requests {
					if err := h.action(context.WithValue(context.Background(), queuedAction{}, true), action); err != nil {
						record("action failed: " + err.Error())
					}
				}
			}()
			awaitSignal(t, attempted)
			noSignal(t, actionsDone, "queued controls ran between stop and replacement")
			close(replace)
			awaitSignal(t, exchanged)
			awaitSignal(t, restarting)
			noSignal(t, actionsDone, "queued controls ran before restart completed")
			close(restart)
			if err := <-installed; (err != nil) != rollback {
				t.Fatal(err)
			}
			awaitSignal(t, actionsDone)
			want := []string{"stop", "exchange", "start new"}
			if rollback {
				want = append(want, "rollback", "recover original")
			}
			want = append(want, "queued start", "queued restart", "queued install")
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(events, want) || running.Load() != bundle.Load() {
				t.Fatalf("events %v, want %v; running bundle %d, installed %d", events, want, running.Load(), bundle.Load())
			}
		})
	}
}

func TestUpdateWaitsForInFlightControlButNotDownload(t *testing.T) {
	ctx := context.Background()
	entered, release, stopped := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	h := &serviceHandoff{service: fakeControlledService{
		request: func(context.Context, string) error { close(entered); <-release; return nil },
		stop:    func(context.Context) (bool, error) { close(stopped); return false, nil },
	}}
	staging, staged := make(chan struct{}), make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		finished <- h.install(ctx, func(ctx context.Context) error {
			close(staging)
			<-staged
			return h.before(ctx)
		})
	}()
	awaitSignal(t, staging)
	actionDone := make(chan error, 1)
	go func() { actionDone <- h.action(ctx, "start") }()
	awaitSignal(t, entered) // Controls are usable during download/staging.
	close(staged)
	noSignal(t, stopped, "update stopped a service while its previous control was in flight")
	once.Do(func() { close(release) })
	if err := <-actionDone; err != nil {
		t.Fatal(err)
	}
	awaitSignal(t, stopped)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

func TestQuitWaitsForCancelledUpdateRecovery(t *testing.T) {
	for _, recoveryFails := range []bool{false, true} {
		name := "recovered"
		if recoveryFails {
			name = "recovery error reported"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stopped, recovering, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
			startError := errors.New("owned CLI could not start")
			var controls atomic.Int32
			h := &serviceHandoff{service: fakeControlledService{
				stop: func(context.Context) (bool, error) { close(stopped); return true, nil },
				request: func(recoveryCtx context.Context, action string) error {
					controls.Add(1)
					deadline, bounded := recoveryCtx.Deadline()
					if action != "start" || recoveryCtx.Err() != nil || !bounded || time.Until(deadline) <= 0 || time.Until(deadline) > serviceRecoveryTimeout {
						return errors.New("recovery did not use an independent bounded start context")
					}
					close(recovering)
					<-release
					if recoveryFails {
						return startError
					}
					return nil
				},
			}}
			requests := make(chan string, 2)
			requests <- "install_update"
			requests <- "install_update" // Must not run after cancellation.
			done, resumed := make(chan struct{}), make(chan struct{}, 2)
			reports := make(chan error, 2)
			result := make(chan bool, 1)
			go func() {
				result <- runUpdateRequests(ctx, requests,
					func(context.Context) error { return errors.New("unexpected check") },
					func(ctx context.Context) error {
						return h.install(ctx, func(ctx context.Context) error {
							if err := h.before(ctx); err != nil {
								return err
							}
							<-ctx.Done()
							return ctx.Err()
						})
					}, func(err error) { reports <- err })
				close(done)
			}()
			awaitSignal(t, stopped)
			shutdown := updateShutdown{done: done}
			cancels := 0
			requestCancel := func() { cancels++; cancel() }
			resume := func() { resumed <- struct{}{} }
			if !shutdown.deferQuit(requestCancel, resume) || !shutdown.deferQuit(requestCancel, resume) || cancels != 1 {
				t.Fatal("quit did not defer once and cancel the update")
			}
			awaitSignal(t, recovering)
			noSignal(t, done, "update worker exited before critical recovery")
			noSignal(t, resumed, "native quit resumed before critical recovery")
			queuedDone := make(chan error, 1)
			go func() { queuedDone <- h.action(ctx, "restart") }()
			releaseOnce.Do(func() { close(release) })
			awaitSignal(t, done)
			awaitSignal(t, resumed)
			if <-result {
				t.Fatal("cancelled update requested relaunch")
			}
			if err := <-queuedDone; !errors.Is(err, context.Canceled) || controls.Load() != 1 {
				t.Fatal("cancelled queued control reached the CLI", err, controls.Load())
			}
			err := <-reports
			if !errors.Is(err, context.Canceled) || errors.Is(err, startError) != recoveryFails {
				t.Fatalf("lost cancellation/recovery error: %v", err)
			}
			if shutdown.deferQuit(requestCancel, resume) || cancels != 1 {
				t.Fatal("completed worker still blocks quit")
			}
			noSignal(t, resumed, "repeated quit spawned duplicate resume callbacks")
		})
	}
}

func TestServiceHandoffOnlyRecoversSuccessfullyStoppedService(t *testing.T) {
	refused := errors.New("foreign registration")
	for _, scenario := range []string{"no registration", "foreign registration", "validation failure", "success"} {
		t.Run(scenario, func(t *testing.T) {
			starts := 0
			h := &serviceHandoff{service: fakeControlledService{
				stop: func(context.Context) (bool, error) {
					switch scenario {
					case "foreign registration":
						return false, refused
					case "no registration":
						return false, nil
					default:
						return true, nil
					}
				},
				request: func(context.Context, string) error { starts++; return nil },
			}}
			err := h.install(context.Background(), func(ctx context.Context) error {
				if scenario == "validation failure" {
					return refused
				}
				if err := h.before(ctx); err != nil {
					return err
				}
				return h.after()
			})
			if errors.Is(err, refused) != (scenario == "foreign registration" || scenario == "validation failure") {
				t.Fatal(err)
			}
			want := 0
			if scenario == "success" {
				want = 1
			}
			if starts != want || h.locked || h.stopped {
				t.Fatalf("starts %d, want %d; handoff state %v/%v", starts, want, h.locked, h.stopped)
			}
			if !h.controls.TryLock() {
				t.Fatal("finished update retained service controls")
			}
			h.controls.Unlock()
		})
	}
}

func TestUpdateWorkerCompletesSuccessfulInstallAndQuitWithoutWorker(t *testing.T) {
	requests := make(chan string, 3)
	requests <- "check_update"
	requests <- "install_update"
	requests <- "install_update"
	var calls []string
	if !runUpdateRequests(context.Background(), requests,
		func(context.Context) error { calls = append(calls, "check"); return nil },
		func(context.Context) error { calls = append(calls, "install"); return nil },
		func(err error) { t.Errorf("unexpected update error: %v", err) }) || !reflect.DeepEqual(calls, []string{"check", "install"}) {
		t.Fatal(calls)
	}
	shutdown := updateShutdown{}
	if shutdown.deferQuit(func() { t.Error("cancel without worker") }, func() { t.Error("resume without worker") }) {
		t.Fatal("no worker should need no quit deferral")
	}
}
