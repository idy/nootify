package main

import "context"

// Only categorical, fixed-schema native readiness data leaves a smoke process.
// Never include native handles, process/thread IDs, URLs, paths or native errors.
type smokePlatformState struct {
	Supported          bool   `json:"supported"`
	ApartmentHRESULT   uint32 `json:"apartment_hresult"`
	Apartment          string `json:"apartment"`
	WindowThreadKnown  bool   `json:"window_thread_known"`
	UIThreadOwnsWindow bool   `json:"ui_thread_owns_window"`
}

type smokeNativeState struct {
	BrowserProcessKnown bool               `json:"browser_process_known"`
	AtOffline           bool               `json:"at_offline"`
	PageLoading         bool               `json:"page_loading"`
	Platform            smokePlatformState `json:"platform"`
}

func safeSmokeNative(state smokeNativeState) smokeNativeState {
	switch state.Platform.Apartment {
	case "not-applicable", "uninitialized", "query-failed", "sta", "mta", "neutral", "main-sta", "unknown":
	default:
		state.Platform.Apartment = "unknown"
	}
	return state
}

func smokeApartment(hr uint32, apartment int32) string {
	if hr == 0x800401f0 {
		return "uninitialized"
	} // CO_E_NOTINITIALIZED
	if int32(hr) < 0 {
		return "query-failed"
	}
	switch apartment {
	case 0:
		return "sta"
	case 1:
		return "mta"
	case 2:
		return "neutral"
	case 3:
		return "main-sta"
	default:
		return "unknown"
	}
}

// The caller is bounded even when native dispatch or a native query is stuck.
// Exactly one worker is started per failed startup; a late UI callback observes
// cancellation before issuing queries, and all deliveries use buffered channels.
func boundedSmokeNative(ctx context.Context, dispatch func(func()), inspect func() smokeNativeState) map[string]any {
	heartbeat := make(chan struct{}, 1)
	result := make(chan smokeNativeState, 1)
	go func() {
		if ctx.Err() != nil {
			return
		}
		dispatch(func() {
			heartbeat <- struct{}{}
			if ctx.Err() != nil {
				return
			}
			result <- inspect()
		})
	}()
	out := map[string]any{"ui_heartbeat": false}
	for {
		select {
		case <-heartbeat:
			out["ui_heartbeat"] = true
		case state := <-result:
			out["ui_heartbeat"] = true
			out["state"] = safeSmokeNative(state)
			return out
		case <-ctx.Done():
			// A callback may have marked the heartbeat while the timeout was
			// selected. Retain that distinction from a completely blocked pump.
			select {
			case <-heartbeat:
				out["ui_heartbeat"] = true
			default:
			}
			select {
			case state := <-result:
				out["ui_heartbeat"] = true
				out["state"] = safeSmokeNative(state)
				return out
			default:
			}
			out["error"] = smokeEvalCategory(ctx.Err())
			return out
		}
	}
}
