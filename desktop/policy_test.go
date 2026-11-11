package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/idy/nootify/desktop/internal/language"
)

func TestURLPolicy(t *testing.T) {
	policy := urlPolicy{offline: "http://127.0.0.1:39847/", gateway: "http://127.0.0.1:39849/"}
	for _, raw := range []string{policy.gateway, policy.gateway + "#/settings/general", policy.offline, policy.offline + "#offline"} {
		if !policy.allowed(raw) {
			t.Errorf("blocked %q", raw)
		}
	}
	for _, raw := range []string{"https://example.com/", "http://localhost:9417/", "http://127.0.0.1:9418/", "http://user@127.0.0.1:9417/", "http://127.0.0.1:9417/v1/sessions", "http://127.0.0.1:9417/%2f", "http://127.0.0.1:9417.evil/", "file:///etc/passwd", "data:text/html,test", "javascript:alert(1)", "about:blank"} {
		if policy.allowed(raw) {
			t.Errorf("allowed %q", raw)
		}
	}
	policy.isolated = true
	policy.preview = "http://127.0.0.1:39848/"
	if policy.allowed("http://127.0.0.1:9417/") {
		t.Fatal("smoke must never display production service")
	}
	if !policy.allowed(policy.preview) || !policy.allowed(policy.offline) {
		t.Fatal("isolated documents blocked")
	}
}
func TestFixedNativeActions(t *testing.T) {
	actions := []string{"window/drag", "window/zoom", "update/check", "update/install", "update/details", "language/system", "language/zh-CN", "language/en", "service/start", "service/restart", "service/install", "service/refresh", "settings/authorize"}
	for _, action := range actions {
		if fixedAction("nootify://"+action) == "" {
			t.Errorf("missing %s", action)
		}
		for _, suffix := range []string{"/", "?", "?x=y", "#", "#x", "%2f", "/extra"} {
			if fixedAction("nootify://"+action+suffix) != "" {
				t.Errorf("accepted %s%s", action, suffix)
			}
		}
	}
	for _, raw := range []string{"nootify://window/close", "nootify://user@window/drag", "nootify://language:9417/en", "nootify://language/%65n", "nootify://language/EN", "https://window/drag", "nootify://service/uninstall"} {
		if fixedAction(raw) != "" {
			t.Errorf("accepted %q", raw)
		}
	}
}
func TestOfficialExternalLinks(t *testing.T) {
	for _, raw := range []string{"https://github.com/idy/nootify/pull/1#discussion_r1", "https://open.feishu.cn/app", "https://open.feishu.cn/app/cli_0123456789abcdef/auth?q=contact:group:readonly", "https://open.feishu.cn/page/cli?user_code=ABCD-1234"} {
		if !externalURL(raw) {
			t.Errorf("blocked %q", raw)
		}
	}
	for _, raw := range []string{"http://github.com/idy/nootify", "https://user@github.com/idy/nootify", "https://github.com:8443/idy/nootify", "https://github.com.evil/idy/nootify", "https://login.tailscale.com/a/abc123", "https://login.tailscale.com/a/a?redirect=evil", "https://login.tailscale.com/a/", "https://open.feishu.cn/document/anything", "https://open.feishu.cn/app#", "https://open.feishu.cn/page/cli?user_code=AB%2DCD", "https://open.feishu.cn/page/cli?user_code=ABCD&other=bad", "https://open.feishu.cn/page/cli?user_code=ABC", "file:///Applications/Calculator.app"} {
		if externalURL(raw) {
			t.Errorf("allowed %q", raw)
		}
	}
}
func TestSmokeURLIsExplicitAndIsolated(t *testing.T) {
	if previewURL("http://127.0.0.1:19417/") == "" {
		t.Fatal("isolated URL rejected")
	}
	for _, raw := range []string{"http://127.0.0.1:9417/", "http://127.0.0.1:0/", "http://localhost:19417/", "http://127.0.0.1/", "https://127.0.0.1:19417/", "http://user@127.0.0.1:19417/", "http://127.0.0.1:19417/other", "http://127.0.0.1:19417/?", "http://127.0.0.1:19417/#"} {
		if previewURL(raw) != "" {
			t.Errorf("accepted %q", raw)
		}
	}
}
func TestOfflineServerOwnsAssetsAndRejectsRebinding(t *testing.T) {
	server, err := startOffline()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(data), "Waiting for the local service") || !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatalf("invalid offline response: %s", data)
	}
	for _, path := range []string{"main.go", "go.mod", "titlebar.js", "../go.mod", "icons/32x32.png"} {
		req := httptest.NewRequest("GET", "http://127.0.0.1:9999/"+path, nil)
		rec := httptest.NewRecorder()
		offlineHandler("127.0.0.1:9999").ServeHTTP(rec, req)
		if rec.Code != 404 {
			t.Errorf("served source path %s: %d", path, rec.Code)
		}
	}
	req := httptest.NewRequest("GET", "http://evil.example/", nil)
	rec := httptest.NewRecorder()
	offlineHandler("127.0.0.1:9999").ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatal("DNS rebinding host accepted")
	}
}
func TestModuleTranslationPreservesUnknownData(t *testing.T) {
	if got := moduleLabel(language.ZH, "lark", "reconnecting"); got != "飞书：重新连接中" {
		t.Fatal(got)
	}
	if got := moduleLabel(language.EN, "unknown", "<literal>"); got != "unknown: <literal>" {
		t.Fatal(got)
	}
}
