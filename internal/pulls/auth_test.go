package pulls

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDeviceAuthPersistsOwnTokenAndAccountShape(t *testing.T) {
	var token atomic.Value
	token.Store("")
	var changed atomic.Int32
	var mu sync.Mutex
	reports := []string{}
	var polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/device/code":
			_ = r.ParseForm()
			if r.Form.Get("scope") != "repo read:org" || r.Form.Get("client_id") != "test-client" {
				t.Error(r.Form)
			}
			jsonResponse(w, 200, map[string]any{"device_code": "private-device", "user_code": "ABCD-EFGH", "verification_uri": "https://github.com/login/device", "expires_in": 30, "interval": 0.001})
		case "/login/oauth/access_token":
			_ = r.ParseForm()
			if r.Form.Get("device_code") != "private-device" || r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" {
				t.Error(r.Form)
			}
			switch polls.Add(1) {
			case 1:
				jsonResponse(w, 200, map[string]any{"error": "authorization_pending"})
			case 2:
				jsonResponse(w, 200, map[string]any{"error": "slow_down", "interval": 0.001})
			default:
				jsonResponse(w, 200, map[string]any{"access_token": "gho_private"})
			}
		case "/graphql":
			if r.Header.Get("Authorization") != "Bearer gho_private" {
				t.Error("wrong token")
			}
			jsonResponse(w, 200, map[string]any{"data": map[string]any{"viewer": map[string]any{"login": "viewer"}}})
		default:
			t.Error(r.URL.Path)
		}
	}))
	defer server.Close()
	auth := NewAuth(AuthOptions{ClientID: "test-client", GitHubURL: server.URL, GraphQLURL: server.URL + "/graphql", GetToken: func() string { return token.Load().(string) }, SetToken: func(value string) error { token.Store(value); return nil }, Changed: func() { changed.Add(1) }, Report: func(record map[string]any) {
		mu.Lock()
		reports = append(reports, record["status"].(string))
		mu.Unlock()
	}})
	defer auth.Close()
	if account := auth.Account(); account.SignedIn || account.Error != "" {
		t.Fatal(account)
	}
	if flow := auth.Start(); flow.Status != "starting" {
		t.Fatal(flow)
	}
	eventually(t, func() bool {
		return token.Load().(string) != "" && auth.Login().Status == "idle" && changed.Load() == 1
	})
	settings := auth.Settings()
	b, _ := json.Marshal(settings)
	if string(b) != `{"account":{"signedIn":true,"login":"viewer"},"login":{"status":"idle"}}` {
		t.Fatal(string(b))
	}
	if strings.Contains(string(b), "private") {
		t.Fatal(string(b))
	}
	if e := auth.SignOut(); e != nil {
		t.Fatal(e)
	}
	if token.Load().(string) != "" || changed.Load() != 2 {
		t.Fatal(token.Load(), changed.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(reports, ",") != "github_login,github_logout" {
		t.Fatal(reports)
	}
}
func TestAuthCancelDoesNotResurrectLogin(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var saved atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/device/code":
			jsonResponse(w, 200, map[string]any{"device_code": "device", "user_code": "CODE", "interval": 0.001})
		case "/login/oauth/access_token":
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
			}
			jsonResponse(w, 200, map[string]any{"access_token": "token"})
		}
	}))
	defer server.Close()
	auth := NewAuth(AuthOptions{GitHubURL: server.URL, SetToken: func(string) error { saved.Add(1); return nil }})
	auth.Start()
	<-entered
	if flow := auth.Cancel(); flow.Status != "idle" || flow.Code != "" {
		t.Fatal(flow)
	}
	close(release)
	if e := auth.Close(); e != nil {
		t.Fatal(e)
	}
	if saved.Load() != 0 || auth.Login().Status != "idle" {
		t.Fatal(saved.Load(), auth.Login())
	}
}
func TestAuthFailureAndAccountCancellation(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login/device/code" {
			jsonResponse(w, 200, map[string]any{"error": "access_denied"})
			return
		}
		if strings.Contains(r.URL.Path, "graphql") {
			select {
			case <-r.Context().Done():
			case <-release:
			}
			return
		}
	}))
	defer server.Close()
	defer close(release)
	auth := NewAuth(AuthOptions{GitHubURL: server.URL, GraphQLURL: server.URL + "/graphql", GetToken: func() string { return "token" }})
	defer auth.Close()
	auth.Start()
	eventually(t, func() bool { return auth.Login().Status == "failed" })
	if auth.Login().Error != "access_denied" {
		t.Fatal(auth.Login())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	account := auth.Account(ctx)
	if account.SignedIn || account.Error == "" {
		t.Fatal(account)
	}
}
