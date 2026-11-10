package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func TestSmokeDiagnosticsProbeOnlyOwnedAssetsAndDoNotFollowRedirects(t *testing.T) {
	offline, err := startOffline()
	if err != nil {
		t.Fatal(err)
	}
	defer offline.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	statuses := smokeAssetStatuses(ctx, offline.URL)
	for _, name := range []string{"document", "brand.svg", "offline.js"} {
		value := statuses[name].(map[string]any)
		if value["status"] != http.StatusOK || value["error"] != "ok" {
			t.Fatal(statuses)
		}
	}
	encoded, err := json.Marshal(statuses)
	if err != nil || strings.Contains(string(encoded), offline.URL) {
		t.Fatal("diagnostics include a native URL", err)
	}

	redirect := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodHead {
			t.Error("diagnostics must never submit page actions")
		}
		http.Redirect(response, request, "http://example.invalid/private-path", http.StatusFound)
	}))
	defer redirect.Close()
	for _, value := range smokeAssetStatuses(ctx, redirect.URL+"/") {
		if value.(map[string]any)["status"] != http.StatusFound {
			t.Fatal("diagnostic probe followed an external redirect")
		}
	}
}

func TestSmokeDiagnosticsRespectSharedCancellationAndDiscardPrivateErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) { <-request.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	for _, value := range smokeAssetStatuses(ctx, server.URL+"/") {
		fields := value.(map[string]any)
		if fields["status"] != 0 || fields["error"] != "canceled" {
			t.Fatal(fields)
		}
	}
	if time.Since(started) > time.Second {
		t.Fatal("diagnostics ignored cancellation")
	}
	for _, tc := range []struct {
		err      error
		category string
	}{
		{&mygo.EvalError{Message: "synthetic-private-page-text"}, "javascript"},
		{&mygo.LoadError{URL: "http://private.invalid", Description: "synthetic-private-native-message"}, "error"},
		{errors.New("synthetic-private-unknown"), "error"},
		{context.DeadlineExceeded, "deadline"},
	} {
		if smokeEvalCategory(tc.err) != tc.category {
			t.Fatal("wrong safe error category")
		}
	}
	production := &shell{}
	production.noteSmokeLoad("failed", 42)
	if len(production.smokeLoadSnapshot()["events"].(map[string]int)) != 0 {
		t.Fatal("production records smoke state")
	}
	isolated := &shell{smoke: true}
	isolated.noteSmokeLoad("synthetic-private-navigation-url", 42)
	isolated.noteSmokeLoad("failed", 7)
	isolated.noteSmokeLoad("failed", 9)
	data, err := json.Marshal(isolated.smokeLoadSnapshot())
	if err != nil || strings.Contains(string(data), "synthetic-private") {
		t.Fatal("unbounded event data escaped", err)
	}
	if !strings.Contains(string(data), `"first_failure_code":7`) || !strings.Contains(string(data), `"last_failure_code":9`) {
		t.Fatal("lost failure code boundaries")
	}
}
