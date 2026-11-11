package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/idy/nootify/internal/storage"
)

func testService(t *testing.T) *Service {
	t.Helper()
	home := t.TempDir()
	// Never inspect or edit the developer's installed agents or service state.
	for _, key := range []string{"CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "APPDATA", "NOOTIFY_TRAE_RULES_FILE", "NOOTIFY_WORKBUDDY_RULES_FILE", "CODEX_APP_SERVER_URL", "CODEX_APP_SERVER_TOKEN", "OPENCODE_SERVER_URL", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"} {
		t.Setenv(key, "")
	}
	store, err := storage.Open(filepath.Join(home, "state"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Options{Store: store, Home: home, Executable: filepath.Join(home, "Nootify executable"), Port: 19417})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(); _ = store.Close() })
	return s
}
func jsonFile(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}
func assertDelivery(t *testing.T, err error, reason string, retryable, uncertain bool) {
	t.Helper()
	var de *DeliveryError
	if !errors.As(err, &de) {
		t.Fatalf("expected DeliveryError, got %v", err)
	}
	if de.Reason != reason || de.Retryable != retryable || de.Uncertain != uncertain {
		t.Fatalf("unexpected delivery classification: %+v", de)
	}
}
func request(t *testing.T, s *Service, method, path string, body any) (int, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	return w.Code, result
}
func TestHTTPRegistrationAndPolledAdapterOwnership(t *testing.T) {
	s := testService(t)
	status, result := request(t, s, "PUT", "/v1/sessions/selected", map[string]any{"adapter": "trae", "session_name": "Selected", "socket_token": "private", "socket_path": "private"})
	if status != 200 || result["session_id"] != "selected" || result["socket_token"] != nil || result["socket_path"] != nil {
		t.Fatalf("registration response %d: %v", status, result)
	}
	status, _ = request(t, s, "PUT", "/v1/sessions/selected", map[string]any{"adapter": "workbuddy", "session_name": "Other"})
	if status != 409 {
		t.Fatalf("changed adapter: %d", status)
	}
	status, _ = request(t, s, "PUT", "/v1/backends/codex", map[string]any{"url": "ws://example.com"})
	if status != 400 {
		t.Fatalf("remote backend allowed: %d", status)
	}
	status, _ = request(t, s, "PUT", "/v1/agents/unknown", map[string]any{"enabled": true})
	if status != 404 {
		t.Fatalf("unknown agent: %d", status)
	}
	status, _ = request(t, s, "PUT", "/v1/agents/codex", map[string]any{})
	if status != 400 {
		t.Fatalf("missing enabled: %d", status)
	}
	status, _ = request(t, s, "POST", "/v1/sessions/%2e%2e%2fother/messages", map[string]any{"text": "x"})
	if status != 400 && status != 404 {
		t.Fatalf("unsafe id: %d", status)
	}
}
func TestObservationsPersistAndListDoesNotDiscover(t *testing.T) {
	s := testService(t)
	if got := s.List().([]PublicSession); len(got) != 0 {
		t.Fatalf("initial sessions %v", got)
	}
	_, err := s.Send(context.Background(), "missing-thread", "hello", "claude-code", nil)
	assertDelivery(t, err, "session_not_local", false, false)
	observed := s.List().([]PublicSession)
	if len(observed) != 1 || observed[0].Availability != "missing" || observed[0].LastResult != "session_not_local" {
		t.Fatalf("bad observation %v", observed)
	}
	other, err := New(s.options)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if got := other.List().([]PublicSession); !reflect.DeepEqual(got, observed) {
		t.Fatalf("observations not persisted: %v", got)
	}
	// Even corrupt agent metadata cannot affect GET /sessions.
	path := filepath.Join(s.options.Home, ".claude", "sessions", "1.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/sessions", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "missing-thread") {
		t.Fatalf("list queried clients: %d %s", w.Code, w.Body.String())
	}
}
func TestPolledInboxPersistsFullReferenceAndReconcilesProof(t *testing.T) {
	s := testService(t)
	if err := s.RegisterPolledSession("trae", "conversation", "Original"); err != nil {
		t.Fatal(err)
	}
	ref := map[string]any{"origin_node_id": "node", "provider_id": "provider", "message_id": "message", "route": map[string]any{"opaque": "keep", "sequence": json.Number("9007199254740993")}, "return_path": []any{"one", "two"}}
	origin := &InboxOrigin{Text: "用户原文", Source: &InboxSource{Channel: "provider", Delivery: InboxDelivery{Adapter: "trae", SessionID: "conversation", Message: ref}}}
	if result, err := s.Send(context.Background(), "conversation", "already formatted", "trae", origin); err != nil || result.Status != "inbox_queued" {
		t.Fatalf("queue: %v %v", result, err)
	}
	first, err := s.inbox("trae", "conversation")
	if err != nil || len(first.Messages) != 1 {
		t.Fatalf("inbox: %v %v", first, err)
	}
	second, err := s.inbox("trae", "conversation")
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatal("read removed or changed pending messages")
	}
	text := first.Messages[0].Text
	if !strings.Contains(text, "用户原文") || strings.Contains(text, "already formatted") || !strings.Contains(text, "message-ack") || strings.Contains(text, "cli.js") {
		t.Fatalf("bad forwarding %s", text)
	}
	token := strings.Split(strings.Split(text, "--message-ref '")[1], "'")[0]
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(decoded, []byte("9007199254740993")) || !bytes.Contains(decoded, []byte("return_path")) {
		t.Fatalf("reference lost: %s", decoded)
	}
	snapshot, err := s.InboxSnapshot()
	if err != nil || len(snapshot) != 1 {
		t.Fatalf("snapshot %v %v", snapshot, err)
	}
	// Later enqueue is not in the cancellation proof snapshot and must survive.
	if _, err = s.Send(context.Background(), "conversation", "later", "trae", origin); err != nil {
		t.Fatal(err)
	}
	removed, err := s.DiscardCanceledInbox(context.Background(), snapshot, []map[string]any{ref})
	if err != nil || len(removed) != 1 {
		t.Fatalf("discard %v %v", removed, err)
	}
	after, err := s.inbox("trae", "conversation")
	if err != nil || len(after.Messages) != 1 || after.Messages[0].ID == first.Messages[0].ID {
		t.Fatalf("snapshot race lost new input %v %v", after, err)
	}
	releases := 0
	s.SetInboxConsumer(func(_ context.Context, message map[string]any) error {
		releases++
		if referenceKey(message) != referenceKey(ref) {
			t.Fatal("wrong reference released")
		}
		return errors.New("core temporarily unavailable")
	})
	if _, err = s.ackInbox(context.Background(), "trae", "conversation", after.Messages[0].ID); err != nil {
		t.Fatal(err)
	}
	if releases != 1 {
		t.Fatalf("releases=%d", releases)
	}
	empty, err := s.inbox("trae", "conversation")
	if err != nil || len(empty.Messages) != 0 {
		t.Fatalf("ack not durable: %v %v", empty, err)
	}
	if _, err = s.ackInbox(context.Background(), "trae", "conversation", after.Messages[0].ID); err != nil {
		t.Fatal("ack is not idempotent")
	}
	reopened, err := New(s.options)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if inbox, err := reopened.inbox("trae", "conversation"); err != nil || len(inbox.Messages) != 0 {
		t.Fatalf("deleted inbox returned after reopen %v %v", inbox, err)
	}
}
func TestPolledInboxBoundsHostAndConversation(t *testing.T) {
	s := testService(t)
	for _, id := range []string{"a", "b"} {
		if err := s.RegisterPolledSession("workbuddy", id, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.queueInbox("workbuddy", "a", strings.Repeat("a", 64001), nil); err == nil {
		t.Fatal("oversize accepted")
	}
	bad := &InboxSource{Channel: "provider", Delivery: InboxDelivery{Adapter: "workbuddy", SessionID: "b", Message: map[string]any{"origin_node_id": "n", "provider_id": "p", "message_id": "m"}}}
	if _, err := s.queueInbox("workbuddy", "a", "wrong", bad); err == nil {
		t.Fatal("cross-conversation source accepted")
	}
	if _, err := s.queueInbox("workbuddy", "a", "private", nil); err != nil {
		t.Fatal(err)
	}
	a, _ := s.inbox("workbuddy", "a")
	if _, err := s.ackInbox(context.Background(), "workbuddy", "b", a.Messages[0].ID); err == nil {
		t.Fatal("cross-conversation ack deleted input")
	}
	for i := 1; i < 100; i++ {
		if _, err := s.queueInbox("workbuddy", "a", fmt.Sprintf("%d", i), nil); err != nil {
			t.Fatal(err)
		}
	}
	_, err := s.queueInbox("workbuddy", "a", "full", nil)
	assertDelivery(t, err, "inbox_full", true, false)
	batch, err := s.inbox("workbuddy", "a")
	if err != nil || len(batch.Messages) != 20 {
		t.Fatalf("batch limit %d %v", len(batch.Messages), err)
	}
	var saved sessionRecord
	if _, err = s.options.Store.Get("sessions", "a", &saved); err != nil {
		t.Fatal(err)
	}
	saved.HostID = "old-host"
	if err = s.options.Store.Put("sessions", "a", saved); err != nil {
		t.Fatal(err)
	}
	_, err = s.inbox("workbuddy", "a")
	assertDelivery(t, err, "session_not_local", false, false)
	if err = s.RegisterPolledSession("workbuddy", "a", "New title"); err != nil {
		t.Fatal(err)
	}
	if s.SessionName("a", "workbuddy") != "a" {
		t.Fatal("reopening changed original title")
	}
	if _, err = s.inbox("workbuddy", "a"); err != nil {
		t.Fatal("explicit reopen did not reconcile host")
	}
}
func TestLegacyInboxDeliveryRoundTripsOpaqueFields(t *testing.T) {
	raw := []byte(`{"adapter":"trae","session_id":"s","message_id":"m","transport_status":"inbox_queued","replies":[{"digest":"d"}],"native":9007199254740993}`)
	var delivery InboxDelivery
	if err := json.Unmarshal(raw, &delivery); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(delivery)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(`"native":9007199254740993`)) || !bytes.Contains(data, []byte(`"transport_status":"inbox_queued"`)) {
		t.Fatalf("legacy source lost: %s", data)
	}
}
func TestBackendEndpointRestrictions(t *testing.T) {
	for _, input := range []string{"http://remote.test", "http://127.0.0.1.evil.test", "http://user@localhost", "http://localhost?a=b", "http://localhost#x", "file:///tmp/socket", "http://localhost?", "http://localhost#"} {
		if _, err := localEndpoint(BackendConnection{URL: input}, "opencode"); err == nil {
			t.Errorf("accepted %s", input)
		}
	}
	for _, input := range []string{"http://localhost:4096", "https://127.0.0.1", "http://[::1]:4096"} {
		if _, err := localEndpoint(BackendConnection{URL: input}, "opencode"); err != nil {
			t.Errorf("rejected %s: %v", input, err)
		}
	}
}
func TestHTTPRejectsInvalidBodyWithoutAgentEdits(t *testing.T) {
	s := testService(t)
	for _, body := range []string{"null", "[]", "\"text\"", "{", "{\"enabled\":\"true\"}"} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/v1/agents/claude", strings.NewReader(body)))
		if w.Code != 400 {
			t.Errorf("body %s: %d", body, w.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(s.options.Home, ".claude")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid request edited prompt")
	}
}

func TestFutureInboxRowsAreRetainedWithoutBlockingCurrentAdapters(t *testing.T) {
	s := testService(t)
	future := map[string]any{"id": "future", "adapter": "future-adapter", "session_id": "conversation", "text": map[string]any{"version": 2}, "source": map[string]any{"channel": "future-channel"}}
	if err := s.options.Store.Put("inbox_messages", "future", future); err != nil {
		t.Fatal(err)
	}
	if err := s.RegisterPolledSession("trae", "conversation", "Selected"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.queueInbox("trae", "conversation", "current message", nil); err != nil {
		t.Fatal(err)
	}
	inbox, err := s.inbox("trae", "conversation")
	if err != nil || len(inbox.Messages) != 1 {
		t.Fatalf("future row blocked inbox: %v %v", inbox, err)
	}
	if _, err := s.ackInbox(context.Background(), "trae", "conversation", inbox.Messages[0].ID); err != nil {
		t.Fatal(err)
	}
	var retained map[string]any
	if ok, err := s.options.Store.Get("inbox_messages", "future", &retained); err != nil || !ok || retained["adapter"] != "future-adapter" {
		t.Fatalf("future row changed: %v %v", retained, err)
	}
}

func TestAcceptedInputSurvivesObservationPersistenceFailure(t *testing.T) {
	s := testService(t)
	reported := false
	s.options.Report = func(record map[string]any) {
		if record["reason"] == "session_history_save_failed" {
			reported = true
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "ses_selected", "title": "Selected", "time": map[string]any{"created": 1, "updated": 2}})
			return
		}
		_ = s.options.Store.Close()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	if err := s.options.Store.Put("backends", "opencode", BackendConnection{URL: server.URL}); err != nil {
		t.Fatal(err)
	}
	result, err := s.Send(context.Background(), "ses_selected", "accepted", "opencode", nil)
	if err != nil || result.Status != "input_accepted" {
		t.Fatalf("accepted input became retryable: %v %v", result, err)
	}
	if !reported {
		t.Fatal("history persistence failure was not reported")
	}
}
