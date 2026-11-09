package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestLogExportDownloadPolicy(t *testing.T) {
	policy := urlPolicy{offline: "http://127.0.0.1:39847/", gateway: "http://127.0.0.1:39849/"}
	const object = "/7a96c860-3250-4c38-b957-85e3a7280d9f"
	const name = "nootify-logs-2026-11-09.ndjson"
	for _, test := range []struct {
		name, document, download, filename string
		allowed                            bool
	}{
		{"trusted log export", "http://127.0.0.1:39849/#/logs", "blob:http://127.0.0.1:39849" + object, name, true},
		{"offline origin", policy.offline, "blob:http://127.0.0.1:39847" + object, name, true},
		{"untrusted document", "https://example.com/", "blob:https://example.com" + object, name, false},
		{"wrong document path", "http://127.0.0.1:39849/v1/sessions", "blob:http://127.0.0.1:39849" + object, name, false},
		{"different blob origin", "http://127.0.0.1:39849/", "blob:http://127.0.0.1:39847" + object, name, false},
		{"foreign blob", "http://127.0.0.1:39849/", "blob:https://example.com" + object, name, false},
		{"opaque blob", "http://127.0.0.1:39849/", "blob:null" + object, name, false},
		{"ordinary URL", "http://127.0.0.1:39849/", "http://127.0.0.1:39849" + object, name, false},
		{"remote attachment", "http://127.0.0.1:39849/", "https://example.com/export", name, false},
		{"local file", "http://127.0.0.1:39849/", "blob:file:///etc/passwd", name, false},
		{"blob credentials", "http://127.0.0.1:39849/", "blob:http://user@127.0.0.1:39849" + object, name, false},
		{"blob query", "http://127.0.0.1:39849/", "blob:http://127.0.0.1:39849" + object + "?x=1", name, false},
		{"blob fragment", "http://127.0.0.1:39849/", "blob:http://127.0.0.1:39849" + object + "#", name, false},
		{"non-object URL", "http://127.0.0.1:39849/", "blob:http://127.0.0.1:39849/exports/logs", name, false},
		{"wrong filename", "http://127.0.0.1:39849/", "blob:http://127.0.0.1:39849" + object, "download.exe", false},
		{"filename path", "http://127.0.0.1:39849/", "blob:http://127.0.0.1:39849" + object, "../" + name, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			event := &mygo.DownloadEvent{URL: test.download, SuggestedName: test.filename, Path: "/synthetic/download/path"}
			policy.download(test.document, event)
			if allowed := !event.DefaultPrevented(); allowed != test.allowed {
				t.Fatalf("allowed = %v, want %v", allowed, test.allowed)
			}
			if event.Path != "/synthetic/download/path" {
				t.Fatal("download policy must retain MyGo's unique destination")
			}
		})
	}
	policy.isolated = true
	event := &mygo.DownloadEvent{URL: "blob:http://127.0.0.1:39849" + object, SuggestedName: name}
	policy.download("http://127.0.0.1:39849/", event)
	if !event.DefaultPrevented() {
		t.Fatal("isolated shell must reject production-service exports")
	}
	policy.preview = "http://127.0.0.1:39848/"
	event = &mygo.DownloadEvent{URL: "blob:http://127.0.0.1:39848" + object, SuggestedName: name}
	policy.download(policy.preview+"#/logs", event)
	if event.DefaultPrevented() {
		t.Fatal("isolated preview log export was blocked")
	}
}
