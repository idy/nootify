package webui

import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/idy/nootify/internal/httpx"
)

func fixture(t *testing.T) (string, *Owner) {
	t.Helper()
	owner := NewOwner(strings.Repeat("a", 64))
	server := httptest.NewUnstartedServer(owner.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !Authenticated(r) {
			httpx.JSON(w, 403, map[string]string{"error": "locked"})
			return
		}
		switch r.URL.Path {
		case "/ui/api/providers":
			httpx.JSON(w, 200, map[string]any{"editable": true, "private": "not-plaintext"})
		case "/ui/api/settings/lark/recipients/stream":
			w.Header().Set("content-type", "application/x-ndjson")
			w.WriteHeader(200)
			_, _ = io.WriteString(w, "{\"type\":\"progress\"}\n")
			w.(http.Flusher).Flush()
			_, _ = io.WriteString(w, "{\"type\":\"complete\"}\n")
		default:
			httpx.JSON(w, 404, map[string]string{"error": "unknown"})
		}
	})))
	server.Config.ConnContext = owner.ConnContext
	server.Config.ConnState = owner.ConnState
	server.Start()
	t.Cleanup(server.Close)
	return server.URL, owner
}
func TestGoOwnerProofAndEncryptedFrames(t *testing.T) {
	base, _ := fixture(t)
	capability, err := RequestSession(context.Background(), base, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(base, capability)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	response, err := client.Fetch(context.Background(), Operation{Method: "GET", Path: "/ui/api/providers"})
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(body), "not-plaintext") {
		t.Fatalf("response %d %s %v", response.StatusCode, body, err)
	}
	stream, err := client.Fetch(context.Background(), Operation{Method: "POST", Path: "/ui/api/settings/lark/recipients/stream", Body: "{}"})
	if err != nil {
		t.Fatal(err)
	}
	body, err = io.ReadAll(stream.Body)
	stream.Body.Close()
	if err != nil || !strings.Contains(string(body), "complete") {
		t.Fatalf("stream interrupted: %s %v", body, err)
	}
	if !client.Healthy() {
		t.Fatal("natural EOF revoked session")
	}
}
func TestWrongTokenCannotBootstrap(t *testing.T) {
	base, _ := fixture(t)
	if _, err := RequestSession(context.Background(), base, strings.Repeat("b", 64)); err == nil {
		t.Fatal("wrong owner secret accepted")
	}
}
func TestInProcessGatewaySurvivesIdleAndOwnsActualLifetime(t *testing.T) {
	base, _ := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	gateway, err := NewGateway(ctx, Options{BaseURL: base, Token: strings.Repeat("a", 64), Route: "#/providers", Assets: fstest.MapFS{"index.html": {Data: []byte("trusted-ui")}}})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	gateway.front.mu.Lock()
	gateway.front.entries[gateway.capability.ID].seen = time.Now().Add(-24 * time.Hour)
	gateway.front.mu.Unlock()
	browser, err := NewClient(strings.TrimRight(gateway.Origin(), "/"), gateway.capability)
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	response, err := browser.Fetch(ctx, Operation{Method: "GET", Path: "/ui/api/providers"})
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !gateway.Alive() {
		t.Fatalf("idle invalidated in-process gateway: %s %v", body, err)
	}
	cancel()
	select {
	case <-gateway.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("context did not close gateway")
	}
	if gateway.Alive() {
		t.Fatal("closed listener reported alive")
	}
}
func TestGatewayRecoversExpiredDaemonLeaseWithoutBreakingBrowser(t *testing.T) {
	base, owner := fixture(t)
	gateway, err := NewGateway(context.Background(), Options{BaseURL: base, Token: strings.Repeat("a", 64), Assets: fstest.MapFS{"index.html": {Data: []byte("trusted-ui")}}})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	browser, _ := NewClient(strings.TrimRight(gateway.Origin(), "/"), gateway.capability)
	defer browser.Close()
	owner.sessions.mu.Lock()
	for _, session := range owner.sessions.entries {
		session.seen = time.Now().Add(-10 * time.Minute)
	}
	owner.sessions.mu.Unlock()
	first, err := browser.Fetch(context.Background(), Operation{Method: "GET", Path: "/ui/api/providers"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(first.Body)
	first.Body.Close()
	if err != nil || first.StatusCode != 200 {
		t.Fatalf("first read after idle must recover transparently, got %d %v", first.StatusCode, err)
	}
	if !browser.Healthy() {
		t.Fatal("upstream expiry revoked browser transport")
	}
	next, err := browser.Fetch(context.Background(), Operation{Method: "GET", Path: "/ui/api/providers"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(next.Body)
	next.Body.Close()
	if err != nil || next.StatusCode != 200 {
		t.Fatalf("poll did not reconnect: %d %v", next.StatusCode, err)
	}
}
func TestMagpieAssetsUseVendoredRootAndPreserveSecurityHeaders(t *testing.T) {
	// Model Windows machines without the browser MIME registrations, even on a
	// development host that knows them. The packaged UI must ignore host overrides.
	for _, extension := range []string{".css", ".js", ".svg", ".woff2", ".ttf"} {
		previous := mime.TypeByExtension(extension)
		if previous == "" {
			previous = "application/octet-stream"
		}
		if err := mime.AddExtensionType(extension, "application/octet-stream"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = mime.AddExtensionType(extension, previous) })
	}
	assets := Assets(fstest.MapFS{
		"vendor/magpie/magpie.css":       {Data: []byte("body { color: black; }")},
		"vendor/magpie/fonts/font.woff2": {Data: []byte("font-data")},
		"ui/fonts/font.ttf":              {Data: []byte("font-data")},
		"vendor/magpie/icons/check.svg":  {Data: []byte("<svg></svg>")},
		"ui/ui-app.js":                   {Data: []byte("console.log('ready')")},
	})
	for _, test := range []struct{ path, contentType string }{
		{"/ui/vendor/magpie/magpie.css", "text/css"},
		{"/ui/vendor/magpie/fonts/font.woff2", "font/woff2"},
		{"/ui/fonts/font.ttf", "font/ttf"},
		{"/ui/vendor/magpie/icons/check.svg", "image/svg+xml"},
		{"/ui/ui-app.js", "javascript"},
	} {
		for _, method := range []string{"GET", "HEAD"} {
			w := httptest.NewRecorder()
			assets.ServeHTTP(w, httptest.NewRequest(method, test.path, nil))
			if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), test.contentType) {
				t.Fatalf("%s %s: %d %v", method, test.path, w.Code, w.Header())
			}
			if w.Header().Get("Content-Security-Policy") != contentPolicy || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("asset security headers lost")
			}
			if method == "HEAD" && w.Body.Len() != 0 {
				t.Fatal("HEAD returned body")
			}
		}
	}
	for _, target := range []string{"/ui/vendor/magpie/../secret", "/ui/vendor/magpie/magpie.css?private=1", "/ui/vendor/magpie/missing.svg"} {
		w := httptest.NewRecorder()
		assets.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 404 {
			t.Fatalf("invalid asset target %s accepted: %d", target, w.Code)
		}
	}
}

func TestReplayRejectedAndNotDispatchedTwice(t *testing.T) {
	sessions := NewSessions(false)
	capability, err := sessions.Create(nil)
	if err != nil {
		t.Fatal(err)
	}
	cd, _ := newCodec(capability)
	request := nonce(24)
	envelope, _ := cd.seal(Operation{Method: "POST", Path: "/ui/api/providers", Body: "{}"}, request, "request")
	if _, _, err = sessions.Open(envelope); err != nil {
		t.Fatal(err)
	}
	if _, _, err = sessions.Open(envelope); err == nil {
		t.Fatal("replayed mutation accepted")
	}
}
