package main

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"github.com/egoist/mygo"
)

// Smoke diagnostics are categorical and isolated from production state. Never
// include native URLs/descriptions, page text, or arbitrary evaluation errors.
type smokeLoadDiagnostics struct {
	mu                        sync.Mutex
	counts                    map[string]int
	firstFailure, lastFailure int
	hasFailure                bool
}

func (s *shell) noteSmokeLoad(event string, code int) {
	if !s.smoke {
		return
	}
	s.smokeLoads.mu.Lock()
	defer s.smokeLoads.mu.Unlock()
	switch event {
	case "finished", "navigated", "blocked", "failed", "renderer_gone":
	default:
		return
	}
	if s.smokeLoads.counts == nil {
		s.smokeLoads.counts = map[string]int{}
	}
	s.smokeLoads.counts[event]++
	if event == "failed" {
		if !s.smokeLoads.hasFailure {
			s.smokeLoads.firstFailure = code
		}
		s.smokeLoads.hasFailure = true
		s.smokeLoads.lastFailure = code
	}
}

func (s *shell) smokeLoadSnapshot() map[string]any {
	s.smokeLoads.mu.Lock()
	defer s.smokeLoads.mu.Unlock()
	counts := map[string]int{}
	for key, value := range s.smokeLoads.counts {
		counts[key] = value
	}
	return map[string]any{"events": counts, "has_failure": s.smokeLoads.hasFailure, "first_failure_code": s.smokeLoads.firstFailure, "last_failure_code": s.smokeLoads.lastFailure}
}

func smokeEvalCategory(err error) string {
	if err == nil {
		return "ok"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var script *mygo.EvalError
	if errors.As(err, &script) {
		return "javascript"
	}
	return "error"
}

// Fixed fields identify the failed clause without uploading page content.
const smokeDocumentSnapshot = `(()=>{const image=document.querySelector('.mark');const lang=v=>v==='en'||v==='zh-CN'?v:typeof v==='string'?'other':'missing';return {ready_state:['loading','interactive','complete'].includes(document.readyState)?document.readyState:'other',heading:!!document.querySelector('h1'),image_present:!!image,image_complete:!!image?.complete,image_has_width:image?.naturalWidth>0,language_present:!!window.__NOOTIFY_LANGUAGE__,language:lang(window.__NOOTIFY_LANGUAGE__?.locale),html_language:lang(document.documentElement.lang),language_matches:window.__NOOTIFY_LANGUAGE__?.locale===document.documentElement.lang,document_seed_captured:typeof window.__nootifySmokeDocumentLanguage==='string',mygo_present:!!window.mygo};})()`

func smokeAssetStatuses(ctx context.Context, base string) map[string]any {
	result := map[string]any{}
	var mu sync.Mutex
	var workers sync.WaitGroup
	for _, name := range []string{"", "brand.svg", "offline.js"} {
		workers.Add(1)
		go func(name string) {
			defer workers.Done()
			request, err := http.NewRequestWithContext(ctx, http.MethodHead, base+name, nil)
			status := 0
			if err == nil {
				client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
				var response *http.Response
				response, err = client.Do(request)
				if err == nil {
					status = response.StatusCode
					response.Body.Close()
				}
			}
			key := name
			if key == "" {
				key = "document"
			}
			mu.Lock()
			result[key] = map[string]any{"status": status, "error": smokeEvalCategory(err)}
			mu.Unlock()
		}(name)
	}
	workers.Wait()
	return result
}
