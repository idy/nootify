package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSmokeNativeProbeDistinguishesResponsiveUIWithoutController(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	calls := 0
	out := boundedSmokeNative(ctx, func(fn func()) { fn() }, func() smokeNativeState {
		calls++
		return smokeNativeState{AtOffline: false, PageLoading: false, BrowserProcessKnown: false, Platform: smokePlatformState{Supported: true, Apartment: "sta", WindowThreadKnown: true, UIThreadOwnsWindow: true}}
	})
	if calls != 1 || out["ui_heartbeat"] != true {
		t.Fatal(out, calls)
	}
	state := out["state"].(smokeNativeState)
	if state.BrowserProcessKnown || state.AtOffline || state.PageLoading || state.Platform.Apartment != "sta" || !state.Platform.UIThreadOwnsWindow {
		t.Fatal(state)
	}
}

func TestSmokeNativeProbeBoundsBlockedDispatcherAndSkipsLateQueries(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	release := make(chan struct{})
	finished := make(chan struct{})
	var queries atomic.Int32
	t.Cleanup(func() {
		close(release)
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("fake dispatcher did not release")
		}
	})
	started := time.Now()
	out := boundedSmokeNative(ctx, func(fn func()) { defer close(finished); <-release; fn() }, func() smokeNativeState { queries.Add(1); return smokeNativeState{} })
	if time.Since(started) > 500*time.Millisecond || out["ui_heartbeat"] != false || out["error"] != "deadline" || queries.Load() != 0 {
		t.Fatal("UI dispatch exceeded caller budget", out)
	}
}

func TestSmokeNativeProbeRetainsHeartbeatWhenNativeInspectionBlocks(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	release := make(chan struct{})
	finished := make(chan struct{})
	t.Cleanup(func() {
		close(release)
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("fake native inspection did not release")
		}
	})
	out := boundedSmokeNative(ctx, func(fn func()) { defer close(finished); fn() }, func() smokeNativeState { <-release; return smokeNativeState{} })
	if out["ui_heartbeat"] != true || out["error"] != "deadline" {
		t.Fatal("lost UI heartbeat", out)
	}
}

func TestSmokeStartupProbesShareBudgetWithoutDependingOnUIPump(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	started := time.Now()
	out := collectSmokeStartup(ctx, smokeStartupHooks{
		dispatch: func(fn func()) { <-release; fn() }, inspect: func() smokeNativeState { t.Error("canceled native inspection ran"); return smokeNativeState{} },
		document: func(context.Context) (any, error) { <-release; return nil, errors.New("synthetic-private-page-error") },
		assets: func(context.Context) map[string]any {
			return map[string]any{"document": map[string]any{"status": 200, "error": "ok"}}
		},
	})
	if time.Since(started) > 500*time.Millisecond || out["startup_native"].(map[string]any)["ui_heartbeat"] != false || out["startup_document"].(map[string]any)["error"] != "deadline" {
		t.Fatal(out)
	}
	if out["startup_assets"].(map[string]any)["document"].(map[string]any)["status"] != 200 {
		t.Fatal("blocked UI held back independent assets", out)
	}
}

func TestSmokeNativeDiagnosticsHaveFixedSchemaAndApartmentEnums(t *testing.T) {
	for _, tc := range []struct {
		hr        uint32
		apartment int32
		want      string
	}{
		{0, 0, "sta"}, {0, 1, "mta"}, {0, 2, "neutral"}, {0, 3, "main-sta"}, {0, 99, "unknown"},
		{0x800401f0, -1, "uninitialized"}, {0x80004001, 1, "query-failed"},
	} {
		if got := smokeApartment(tc.hr, tc.apartment); got != tc.want {
			t.Fatal(tc, got)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out := collectSmokeStartup(ctx, smokeStartupHooks{
		dispatch: func(fn func()) { fn() }, inspect: func() smokeNativeState {
			return smokeNativeState{Platform: smokePlatformState{Supported: true, Apartment: "synthetic-private-apartment", ApartmentHRESULT: 0x80004001}}
		},
		document: func(context.Context) (any, error) {
			return nil, errors.New("http://private.invalid/root-token?secret=synthetic-private")
		},
		assets: func(context.Context) map[string]any {
			return map[string]any{"document": map[string]any{"status": 200, "error": "ok"}}
		},
	})
	data, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"synthetic-private", "private.invalid", "root-token", "secret=", "window_handle", "thread_id", "process_id"} {
		if strings.Contains(string(data), private) {
			t.Fatal("private native data escaped diagnostics", string(data))
		}
	}
	if out["startup_native"].(map[string]any)["state"].(smokeNativeState).Platform.Apartment != "unknown" {
		t.Fatal(out)
	}
}
