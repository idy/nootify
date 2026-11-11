package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRetainedLegacyCallbacksKeepDestinationAndDeduplicate(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "synthetic-secret", true)
	sent := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if strings.Contains(r.URL.Path, "tenant_access_token") {
			_, _ = w.Write([]byte(`{"code":0,"tenant_access_token":"synthetic-token"}`))
			return
		}
		if r.URL.Path != "/open-apis/im/v1/messages/om_old/reply" || r.Header.Get("authorization") != "Bearer synthetic-token" {
			t.Error("unexpected remote operation", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["reply_in_thread"] != true || !strings.Contains(str(body["content"]), "[Original session] hello") {
			t.Error("lost original thread/session", body)
		}
		sent++
		_, _ = w.Write([]byte(`{"code":0,"data":{"message_id":"om_reply","chat_id":"oc_original"}}`))
	}))
	defer api.Close()
	s.options.APIBaseURL = api.URL
	s.options.HTTPClient = api.Client()
	if err := s.options.Store.Put("lark_deliveries", "om_old", map[string]any{"message_id": "om_old", "chat_id": "oc_original", "session_id": "session_old", "session_name": "Original session", "thread_id": "omt_original", "transport_status": "socket_written", "replies": []any{}}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		request := httptest.NewRequest("POST", "/v1/lark/messages/om_old/reply", strings.NewReader(`{"text":"hello"}`))
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, request)
		if response.Code != 200 || !strings.Contains(response.Body.String(), "om_reply") {
			t.Fatalf("old callback: %d %s", response.Code, response.Body.String())
		}
	}
	if sent != 1 {
		t.Fatalf("legacy retry duplicated reply: %d", sent)
	}
	if _, err := s.legacyCallback(context.Background(), "unknown", "reply", "hello"); err == nil {
		t.Fatal("unknown destination accepted")
	}
	if sent != 1 {
		t.Fatal("unknown callback reached external API")
	}
}
