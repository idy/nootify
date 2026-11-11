package bridge

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

func codexFixture(t *testing.T, s *Service, name string, archived int) *sql.DB {
	t.Helper()
	if err := os.MkdirAll(s.codexHome(), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(s.codexHome(), name))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,archived INTEGER); INSERT INTO threads VALUES ('thread-selected','Local title',?)`, archived); err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
func TestCodexNewestDatabaseArchiveAndTargetedLookup(t *testing.T) {
	s := testService(t)
	codexFixture(t, s, "state_9.sqlite", 0)
	newest := codexFixture(t, s, "state_10.sqlite", 1)
	row, err := s.findCodexThread(context.Background(), "thread-selected")
	if err != nil || row == nil || !row.Archived {
		t.Fatalf("did not select newest sqlite state: %v %v", row, err)
	}
	_, err = s.Send(context.Background(), "thread-selected", "never unarchive", "codex", nil)
	assertDelivery(t, err, "session_archived", false, false)
	_, err = s.Send(context.Background(), "thread-other", "never enumerate", "codex", nil)
	assertDelivery(t, err, "session_not_local", false, false)
	if _, err = newest.Exec(`UPDATE threads SET archived=NULL`); err != nil {
		t.Fatal(err)
	}
	_, err = s.Send(context.Background(), "thread-selected", "unknown archive", "codex", nil)
	assertDelivery(t, err, "archive_unknown", false, false)
}
func TestCodexRPCActiveTurnAndInteractiveRequestRejection(t *testing.T) {
	s := testService(t)
	codexFixture(t, s, "state_5.sqlite", 0)
	methods := []string{}
	var mu sync.Mutex
	rejected := make(chan bool, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing app-server token")
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		interactiveSent := false
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var frame map[string]any
			if json.Unmarshal(raw, &frame) != nil {
				return
			}
			if frame["error"] != nil {
				rejected <- true
				continue
			}
			method, _ := frame["method"].(string)
			mu.Lock()
			methods = append(methods, method)
			mu.Unlock()
			if frame["id"] == nil {
				continue
			}
			params, _ := frame["params"].(map[string]any)
			var result any = map[string]any{}
			switch method {
			case "initialize":
			case "thread/read":
				if params["threadId"] != "thread-selected" {
					t.Error("lookup was not targeted")
				}
				result = map[string]any{"thread": map[string]any{"id": "thread-selected", "name": "Remote title", "status": map[string]any{"type": "active"}}}
				if !interactiveSent {
					interactiveSent = true
					question, _ := json.Marshal(map[string]any{"id": 999, "method": "item/commandExecution/requestApproval", "params": map[string]any{}})
					_ = conn.Write(ctx, websocket.MessageText, question)
				}
			case "thread/turns/list":
				result = map[string]any{"data": []any{map[string]any{"id": "active-turn", "status": "inProgress"}}}
			case "turn/steer":
				if params["expectedTurnId"] != "active-turn" {
					t.Error("missing atomic turn guard")
				}
				input := params["input"].([]any)
				if input[0].(map[string]any)["text"] != "[Nootify: Remote title]\nreply" {
					t.Errorf("wrong text: %v", input)
				}
			default:
				t.Errorf("unexpected RPC method %s", method)
			}
			reply, _ := json.Marshal(map[string]any{"id": frame["id"], "result": result})
			if conn.Write(ctx, websocket.MessageText, reply) != nil {
				return
			}
		}
	}))
	defer server.Close()
	if err := s.options.Store.Put("backends", "codex", BackendConnection{URL: "ws" + strings.TrimPrefix(server.URL, "http"), Token: "secret"}); err != nil {
		t.Fatal(err)
	}
	result, err := s.Send(context.Background(), "thread-selected", "reply", "codex", nil)
	if err != nil || result.Status != "input_accepted" {
		t.Fatalf("send %v %v", result, err)
	}
	select {
	case <-rejected:
	default:
		t.Fatal("interactive approval request was not rejected")
	}
	mu.Lock()
	defer mu.Unlock()
	expected := []string{"initialize", "initialized", "thread/read", "thread/turns/list", "turn/steer"}
	if !reflect.DeepEqual(methods, expected) {
		t.Fatalf("unsafe RPC flow %v", methods)
	}
}
func TestCodexRPCDisconnectAfterMutationIsUncertain(t *testing.T) {
	s := testService(t)
	codexFixture(t, s, "state_5.sqlite", 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, raw, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var frame map[string]any
			_ = json.Unmarshal(raw, &frame)
			method := frame["method"]
			if frame["id"] == nil {
				continue
			}
			if method == "turn/start" {
				return
			}
			var result any = map[string]any{}
			if method == "thread/read" {
				result = map[string]any{"thread": map[string]any{"id": "thread-selected", "status": map[string]any{"type": "idle"}}}
			}
			reply, _ := json.Marshal(map[string]any{"id": frame["id"], "result": result})
			_ = conn.Write(r.Context(), websocket.MessageText, reply)
		}
	}))
	defer server.Close()
	if err := s.options.Store.Put("backends", "codex", BackendConnection{URL: "ws" + strings.TrimPrefix(server.URL, "http")}); err != nil {
		t.Fatal(err)
	}
	_, err := s.Send(context.Background(), "thread-selected", "one mutation", "codex", nil)
	assertDelivery(t, err, "delivery_unconfirmed", false, true)
}
func TestCodexRPCRechecksArchiveBeforeInput(t *testing.T) {
	s := testService(t)
	db := codexFixture(t, s, "state_5.sqlite", 0)
	mutated := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, raw, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var frame map[string]any
			_ = json.Unmarshal(raw, &frame)
			if frame["id"] == nil {
				continue
			}
			method := frame["method"]
			if method == "turn/start" || method == "turn/steer" {
				mutated = true
			}
			var result any = map[string]any{}
			if method == "thread/read" {
				_, _ = db.Exec(`UPDATE threads SET archived=1 WHERE id='thread-selected'`)
				result = map[string]any{"thread": map[string]any{"id": "thread-selected", "status": map[string]any{"type": "idle"}}}
			}
			reply, _ := json.Marshal(map[string]any{"id": frame["id"], "result": result})
			_ = conn.Write(r.Context(), websocket.MessageText, reply)
		}
	}))
	defer server.Close()
	if err := s.options.Store.Put("backends", "codex", BackendConnection{URL: "ws" + strings.TrimPrefix(server.URL, "http")}); err != nil {
		t.Fatal(err)
	}
	_, err := s.Send(context.Background(), "thread-selected", "archive race", "codex", nil)
	assertDelivery(t, err, "session_archived", false, false)
	if mutated {
		t.Fatal("input sent after archive state changed")
	}
}
func TestOpenCodeSelectedSessionAuthenticationAndArchive(t *testing.T) {
	s := testService(t)
	archived := false
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "opencode" || password != "secret" {
			t.Error("missing basic auth")
		}
		if r.URL.Query().Get("directory") != "/selected/project" {
			t.Errorf("missing directory: %s", r.URL.String())
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /session/ses_selected":
			at := map[string]any{"created": 1, "updated": 2}
			if archived {
				at["archived"] = 3
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "ses_selected", "title": "OpenCode title", "time": at})
		case "POST /session/ses_selected/prompt_async":
			posts++
			data, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(data), "[Nootify: OpenCode title]\\nhello") {
				t.Errorf("wrong prompt: %s", data)
			}
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected endpoint: %s %s", r.Method, r.URL)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	if err := s.options.Store.Put("backends", "opencode", BackendConnection{URL: server.URL, Password: "secret", Directory: "/selected/project"}); err != nil {
		t.Fatal(err)
	}
	result, err := s.Send(context.Background(), "ses_selected", "hello", "opencode", nil)
	if err != nil || result.Status != "input_accepted" {
		t.Fatalf("send %v %v", result, err)
	}
	archived = true
	_, err = s.Send(context.Background(), "ses_selected", "hello", "opencode", nil)
	assertDelivery(t, err, "session_archived", false, false)
	if posts != 1 {
		t.Fatalf("posted archived session: %d", posts)
	}
}
func TestOpenCodeInputHTTPFailuresClassifiedSafely(t *testing.T) {
	for _, status := range []int{400, 401, 404, 429, 500, 307} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s := testService(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "ses_selected", "title": "T", "time": map[string]any{"created": 1, "updated": 2}})
					return
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			if err := s.options.Store.Put("backends", "opencode", BackendConnection{URL: server.URL}); err != nil {
				t.Fatal(err)
			}
			_, err := s.Send(context.Background(), "ses_selected", "hello", "opencode", nil)
			switch status {
			case 400, 404:
				assertDelivery(t, err, "delivery_failed", false, false)
			case 401, 429:
				assertDelivery(t, err, "backend_unavailable", true, false)
			default:
				assertDelivery(t, err, "delivery_unconfirmed", false, true)
			}
		})
	}
}
func TestOpenCodeRejectsUnknownArchiveAndLookupRedirects(t *testing.T) {
	for _, scenario := range []string{"missing-time", "wrong-session", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			s := testService(t)
			posts := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posts++
					w.WriteHeader(204)
					return
				}
				switch scenario {
				case "missing-time":
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "ses_selected"})
				case "wrong-session":
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "ses_other", "time": map[string]any{"created": 1, "updated": 2}})
				case "redirect":
					w.Header().Set("Location", "http://127.0.0.1:9/session/other")
					w.WriteHeader(302)
				}
			}))
			defer server.Close()
			if err := s.options.Store.Put("backends", "opencode", BackendConnection{URL: server.URL}); err != nil {
				t.Fatal(err)
			}
			_, err := s.Send(context.Background(), "ses_selected", "blocked", "opencode", nil)
			if err == nil {
				t.Fatal("invalid lookup allowed input")
			}
			if posts != 0 {
				t.Fatal("posted after invalid archive lookup")
			}
		})
	}
}
