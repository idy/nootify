package host

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/idy/nootify/internal/webui"
)

func isolate(t *testing.T) {
	t.Helper()
	for _, key := range []string{"LARK_APP_ID", "LARK_APP_SECRET", "LARK_NOTIFY_OPEN_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "OPENCODE_SERVER_URL"} {
		t.Setenv(key, "")
	}
}
func newFixture(t *testing.T) *Server {
	t.Helper()
	isolate(t)
	s, err := New(context.Background(), Options{StateDir: t.TempDir(), Home: t.TempDir(), Port: 0, Version: "test-go", Executable: "/synthetic/Nootify", Assets: fstest.MapFS{"index.html": {Data: []byte("trusted-ui")}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}
func call(t *testing.T, s *Server, method, path string, body any, authenticated bool) (int, map[string]any) {
	t.Helper()
	var encoded []byte
	if body != nil {
		encoded, _ = json.Marshal(body)
	}
	request, _ := http.NewRequest(method, s.URL()+path, bytes.NewReader(encoded))
	if authenticated {
		request.Header.Set("authorization", "Bearer "+s.State().Token)
	}
	request.Header.Set("x-nootify-ui", "1")
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, result
}
func TestUnifiedGoServiceOwnsAPIAndDurableInbox(t *testing.T) {
	s := newFixture(t)
	status, health := call(t, s, "GET", "/health", nil, false)
	if status != 200 || health["backend"] != "go" {
		t.Fatalf("not Go backend: %+v", health)
	}
	status, _ = call(t, s, "PUT", "/v1/sessions/cooperative", map[string]any{"adapter": "trae", "session_name": "Durable test"}, true)
	if status != 200 {
		t.Fatal(status)
	}
	status, delivery := call(t, s, "POST", "/v1/sessions/cooperative/messages", map[string]any{"adapter": "trae", "text": "one durable message"}, true)
	if status != 200 || delivery["status"] != "inbox_queued" {
		t.Fatalf("delivery: %d %+v", status, delivery)
	}
	status, inbox := call(t, s, "POST", "/v1/sessions/cooperative/inbox", map[string]any{"adapter": "trae"}, true)
	messages, ok := inbox["messages"].([]any)
	if status != 200 || !ok || len(messages) != 1 {
		t.Fatalf("missing inbox message: %+v", inbox)
	}
	id := messages[0].(map[string]any)["id"].(string)
	status, _ = call(t, s, "POST", "/v1/sessions/cooperative/inbox/"+id+"/ack", map[string]any{"adapter": "trae"}, true)
	if status != 200 {
		t.Fatal(status)
	}
	status, inbox = call(t, s, "POST", "/v1/sessions/cooperative/inbox", map[string]any{"adapter": "trae"}, true)
	if status != 200 || len(inbox["messages"].([]any)) != 0 {
		t.Fatal("ack did not persist")
	}
}
func TestHTTPPermissionsAndProviderSecrets(t *testing.T) {
	s := newFixture(t)
	status, _ := call(t, s, "GET", "/v1/services", nil, false)
	if status != 401 {
		t.Fatalf("control API lost authentication: %d", status)
	}
	provider := map[string]any{"id": "remote-disabled", "name": "Disabled", "type": "remote", "enabled": false, "address": "127.0.0.1:23456", "token": "private-test-secret"}
	status, result := call(t, s, "POST", "/ui/api/providers", map[string]any{"action": "save", "provider": provider}, false)
	if status != 200 {
		t.Fatalf("native provider save failed %d %+v", status, result)
	}
	status, page := call(t, s, "GET", "/ui/api/providers", nil, false)
	raw, _ := json.Marshal(page)
	if status != 200 || page["editable"] != true || bytes.Contains(raw, []byte("private-test-secret")) {
		t.Fatalf("local provider summary failed or leaked a secret: %s", raw)
	}
	for _, change := range []struct{ header, value string }{{"Host", "attacker.example"}, {"Origin", "http://attacker.example"}, {"Sec-Fetch-Site", "cross-site"}, {"Sec-Fetch-Site", "same-site"}} {
		request, _ := http.NewRequest("GET", s.URL()+"/ui/api/snapshot", nil)
		if change.header == "Host" {
			request.Host = change.value
		} else {
			request.Header.Set(change.header, change.value)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 403 {
			t.Fatalf("%s accepted: %d", change.header, response.StatusCode)
		}
	}
}
func TestBrowserEncryptionAgainstUnifiedService(t *testing.T) {
	s := newFixture(t)
	capability, err := webui.RequestSession(context.Background(), s.URL(), s.State().Token)
	if err != nil {
		t.Fatal(err)
	}
	client, err := webui.NewClient(s.URL(), capability)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, path := range []string{"/ui/api/snapshot", "/ui/api/providers", "/ui/api/settings", "/ui/api/agents", "/ui/api/pulls"} {
		response, err := client.Fetch(context.Background(), webui.Operation{Method: "GET", Path: path})
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || !json.Valid(data) {
			t.Fatalf("%s: %d %s %v", path, response.StatusCode, data, err)
		}
	}
}
func TestOccupiedPortDoesNotTouchState(t *testing.T) {
	isolate(t)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	directory := t.TempDir() + "/must-not-create"
	_, err = New(context.Background(), Options{Port: listener.Addr().(*net.TCPAddr).Port, StateDir: directory, Assets: fstest.MapFS{"index.html": {Data: []byte("ui")}}})
	if err == nil || !strings.Contains(err.Error(), "address already in use") {
		t.Fatalf("occupied service was replaced: %v", err)
	}
}

func TestDirectLocalUIHeadersAndPeerBoundary(t *testing.T) {
	s := newFixture(t)
	for _, path := range []string{"/ui/api/providers", "/ui/api/settings/remote/secret", "/ui/api/agents", "/ui/api/settings/import"} {
		request, _ := http.NewRequest("POST", s.URL()+path, strings.NewReader("{}"))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 403 {
			t.Fatalf("headerless %s returned %d", path, response.StatusCode)
		}
	}
	for _, peer := range []string{"192.0.2.1:4000", "100.64.0.2:5000", "[2001:db8::1]:5000", "", "localhost:1234"} {
		request := httptest.NewRequest("POST", "http://127.0.0.1:9417/ui/api/providers", strings.NewReader("{}"))
		request.RemoteAddr = peer
		request.Header.Set("X-Nootify-UI", "1")
		request.Header.Set("X-Forwarded-For", "127.0.0.1")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("remote peer %q got %d", peer, response.Code)
		}
	}
	for _, peer := range []string{"127.0.0.1:4000", "[::1]:5000", "[::ffff:127.0.0.1]:5000"} {
		request := httptest.NewRequest("GET", "http://127.0.0.1:9417/ui/api/settings", nil)
		request.RemoteAddr = peer
		if !uiEditable(request) {
			t.Fatalf("local peer %q locked", peer)
		}
	}
	for _, path := range []string{"/ui/api/providers", "/ui/api/agents", "/ui/api/settings", "/ui/api/settings/remote"} {
		status, page := call(t, s, "GET", path, nil, false)
		if status != 200 || page["editable"] != true {
			t.Fatalf("direct local %s not editable: %d %+v", path, status, page)
		}
	}
	status, snapshot := call(t, s, "GET", "/ui/api/snapshot", nil, false)
	if status != 200 || snapshot["access"].(map[string]any)["owner_authenticated"] != false {
		t.Fatal("local editing incorrectly claims cryptographic authentication")
	}
	status, _ = call(t, s, "POST", "/ui/api/settings/remote/secret", nil, false)
	if status != 200 {
		t.Fatalf("direct local secret action denied: %d", status)
	}
}
