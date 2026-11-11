package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestThreadOpenLostResponseRetainsPolledSessionIdentity(t *testing.T) {
	for _, adapter := range []string{"trae", "workbuddy"} {
		t.Run(adapter, func(t *testing.T) {
			created := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/v1/threads" {
					t.Error("unexpected request", r.Method, r.URL.Path)
					return
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				id, _ := body["session_id"].(string)
				created <- id
				// Model a committed binding whose response is lost before reaching the CLI.
				connection, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				_ = connection.Close()
			}))
			defer server.Close()
			directory := t.TempDir()
			if err := os.WriteFile(filepath.Join(directory, "auth-token"), []byte(strings.Repeat("a", 64)), 0600); err != nil {
				t.Fatal(err)
			}
			base, _ := url.Parse(server.URL)
			var output, stderr bytes.Buffer
			handled, err := Run(context.Background(), []string{"thread-open", "--agent", adapter, "--session-name", "Retry identity", "--state-dir", directory, "--port", base.Port()}, "test", &output, &stderr)
			if !handled || err == nil {
				t.Fatal("lost response was not reported")
			}
			id := <-created
			if id == "" {
				t.Fatal("no generated session identity")
			}
			if !strings.Contains(err.Error(), "--agent "+adapter+" --session-id "+id) {
				t.Fatalf("binding cannot be recovered with same ID: %v", err)
			}
		})
	}
}
