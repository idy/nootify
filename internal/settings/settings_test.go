package settings

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idy/nootify/internal/storage"
)

const testApp = "cli_0123456789abcdef"
const nextApp = "cli_fedcba9876543210"

type fakeCore struct {
	mu                        sync.Mutex
	store                     *storage.Store
	creds                     Credentials
	recipient, connectionType string
	backup                    map[string]any
	calls                     []string
	mutationErr               error
}
type codedError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *codedError) Error() string { return e.Message }
func (c *fakeCore) call(ctx context.Context, method string, p any) (any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, method)
	get := func() any {
		out := map[string]any{"recipient": c.recipient, "source": "settings", "connection_type": c.connectionType, "status": "connected", "provider_id": "test-provider"}
		if c.creds.AppID != "" {
			out["credentials"] = map[string]any{"appId": c.creds.AppID, "appSecret": c.creds.AppSecret}
		}
		return out
	}
	switch method {
	case "compatibility.get":
		return get(), nil
	case "compatibility.configure":
		m := object(p)
		if text(m["app_id"]) != "" {
			if text(m["app_id"]) != c.creds.AppID {
				c.recipient = ""
			}
			c.creds = Credentials{text(m["app_id"]), text(m["app_secret"])}
		}
		if v, ok := m["recipient_open_id"]; ok {
			c.recipient = text(v)
		}
		if v, ok := m["connection_type"]; ok {
			c.connectionType = text(v)
		}
		if e := c.store.SetSettings(map[string]any{"lark_app_id": c.creds.AppID, "lark_app_secret": c.creds.AppSecret, "lark_recipient_open_id": c.recipient, "lark_connection_type": c.connectionType}); e != nil {
			return nil, e
		}
		return get(), c.mutationErr
	case "config.export":
		return c.backup, nil
	case "config.import":
		c.backup = object(object(p)["config"])
		for _, v := range array(c.backup["providers"]) {
			m := object(v)
			if m["type"] == "feishu" {
				c.creds = Credentials{text(m["app_id"]), text(m["app_secret"])}
				c.recipient = text(m["recipient_open_id"])
				break
			}
		}
		return map[string]any{"imported": true}, c.mutationErr
	}
	return nil, fmt.Errorf("unexpected method %s", method)
}
func harness(t *testing.T, edit func(*Options)) (*Service, *fakeCore) {
	t.Helper()
	store, e := storage.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = store.Close() })
	c := &fakeCore{store: store, creds: Credentials{testApp, "synthetic-old-secret"}, connectionType: "bot", backup: map[string]any{"version": 1, "providers": []any{map[string]any{"id": "legacy-feishu", "name": "Synthetic", "type": "feishu", "enabled": true, "app_id": testApp, "app_secret": "synthetic-old-secret"}}, "remote": map[string]any{"enabled": false, "listen": "127.0.0.1:9418", "token": "synthetic-listener-token"}}}
	if e = store.SetSettings(map[string]any{"lark_app_id": testApp, "lark_app_secret": "synthetic-old-secret"}); e != nil {
		t.Fatal(e)
	}
	o := Options{Store: store, Version: "test-version", Env: map[string]string{}, Core: c.call, Verify: func(context.Context, Credentials) error { return nil }}
	if edit != nil {
		edit(&o)
	}
	s, e := New(o)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, c
}
func document(lark map[string]any) map[string]any {
	return map[string]any{"format": "nootify-config", "version": 1, "lark": lark}
}
func TestMalformedTokenReplyCannotReplaceWorkingCredentials(t *testing.T) {
	for _, reply := range []string{`{"msg":"missing code"}`, `{"code":"0","tenant_access_token":"invalid-shape"}`, `{"code":0}`, `{"code":99991663}`} {
		t.Run(reply, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, reply) }))
			defer upstream.Close()
			s, c := harness(t, func(o *Options) { o.APIBaseURL = upstream.URL; o.Verify = nil })
			if e := s.SaveLark(context.Background(), nextApp, "new-secret", "bot"); e == nil {
				t.Fatal("invalid token response accepted")
			}
			if c.creds.AppID != testApp || s.options.Store.Setting("lark_app_secret") != "synthetic-old-secret" {
				t.Fatal("failed verification replaced working credentials")
			}
		})
	}
}
func TestCancelledTokenWaitDoesNotWaitForAnotherRequest(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		dataReply(w, map[string]any{})
	}))
	defer upstream.Close()
	s, _ := harness(t, func(o *Options) { o.APIBaseURL = upstream.URL })
	api := s.api(Credentials{testApp, "synthetic"})
	first := make(chan struct{})
	go func() { _, _ = api.accessToken(context.Background()); close(first) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("token request not started")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	second := make(chan error, 1)
	go func() { _, e := api.accessToken(ctx); second <- e }()
	select {
	case e := <-second:
		if !errors.Is(e, context.Canceled) {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		close(release)
		<-first
		t.Fatal("cancelled request waited for token lock")
	}
	close(release)
	<-first
}
func TestMalformedImportsNeverMutateSecrets(t *testing.T) {
	invalid := []map[string]any{
		{"backends": map[string]any{"codex": map[string]any{"url": "wss://outside.example/"}}},
		{"backends": map[string]any{"opencode": map[string]any{"url": "http://localhost:5000", "token": 12}}},
		{"providers": map[string]any{"version": 1, "providers": []any{map[string]any{"id": "bad", "name": "bad", "type": "feishu", "app_id": nextApp}}, "remote": map[string]any{}}},
		{"providers": map[string]any{"version": 1, "providers": []any{}, "remote": map[string]any{"enabled": true, "listen": "0.0.0.0:9418", "token": "x"}}},
		{"pulls": map[string]any{"config": map[string]any{"authors": []any{123}}}},
		{"pulls": map[string]any{"follow": []any{map[string]any{"repository": "owner/repo", "follow": "yes"}}}},
		{"agents": []any{"codex", "unknown"}},
	}
	for i, extra := range invalid {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			s, c := harness(t, nil)
			if e := s.options.Store.Put("backends", "codex", map[string]any{"url": "ws://localhost:1234", "token": "keep"}); e != nil {
				t.Fatal(e)
			}
			v := document(map[string]any{"app_id": nextApp, "app_secret": "must-never-save"})
			for k, x := range extra {
				v[k] = x
			}
			if _, e := s.ImportConfig(context.Background(), v); e == nil {
				t.Fatal("malformed import accepted")
			}
			if got := s.options.Store.Setting("lark_app_secret"); got != "synthetic-old-secret" {
				t.Fatalf("secret mutated: %q", got)
			}
			if len(c.calls) != 0 {
				t.Fatalf("core called before validation: %v", c.calls)
			}
			var b map[string]any
			_, _ = s.options.Store.Get("backends", "codex", &b)
			if b["token"] != "keep" {
				t.Fatal("backend mutated")
			}
			if _, e := os.Stat(s.exportsDir()); !errors.Is(e, os.ErrNotExist) {
				t.Fatal("invalid document wrote a backup")
			}
		})
	}
}
func TestCredentialPrecedenceAndMCPFlags(t *testing.T) {
	s, _ := harness(t, nil)
	path := filepath.Join(t.TempDir(), "mcp.json")
	if e := os.WriteFile(path, []byte(`{"mcpServers":{"lark":{"args":["--app-id","cli_fromflag","--app-secret","flag-secret"],"env":{"LARK_APP_ID":"cli_fromenv"}}}}`), 0600); e != nil {
		t.Fatal(e)
	}
	c, source, e := resolveCredentials(map[string]string{}, "saved", "saved-secret", path)
	if e != nil || c.AppID != "saved" || source != "settings" {
		t.Fatalf("saved precedence: %+v %s %v", c, source, e)
	}
	c, source, e = resolveCredentials(map[string]string{}, "", "", path)
	if e != nil || c.AppID != "cli_fromenv" || c.AppSecret != "flag-secret" || source != "mcp-config" {
		t.Fatalf("MCP: %+v %s %v", c, source, e)
	}
	c, source, e = resolveCredentials(map[string]string{"LARK_APP_ID": "environment", "LARK_APP_SECRET": "env-secret"}, "saved", "saved-secret", "/missing")
	if e != nil || c.AppID != "environment" || source != "environment" {
		t.Fatal("environment precedence lost")
	}
	if _, _, e = resolveCredentials(map[string]string{"LARK_APP_ID": "partial"}, "saved", "secret", path); e == nil {
		t.Fatal("partial environment silently fell back")
	}
	s.options.MCPConfig = "/does-not-exist"
	if e = s.ClearLark(context.Background()); e == nil {
		t.Fatal("clear ignored unreadable fallback")
	}
	if got := s.options.Store.Setting("lark_app_secret"); got != "synthetic-old-secret" {
		t.Fatal("clear mutated before fallback resolved")
	}
}
func TestSaveVerifiesAndRetainsMaskedSecret(t *testing.T) {
	var verified []Credentials
	s, c := harness(t, func(o *Options) {
		o.Verify = func(ctx context.Context, c Credentials) error {
			verified = append(verified, c)
			if c.AppSecret == "wrong" {
				return errors.New("refused")
			}
			return nil
		}
	})
	if e := s.SaveLark(context.Background(), testApp, "wrong", nil); e == nil {
		t.Fatal("unverified saved")
	}
	if c.creds.AppSecret != "synthetic-old-secret" {
		t.Fatal("rejected verify replaced old secret")
	}
	if e := s.SaveLark(context.Background(), testApp, "", nil); e != nil {
		t.Fatal(e)
	}
	if len(verified) != 2 || verified[1].AppSecret != "synthetic-old-secret" {
		t.Fatal("masked secret not retained")
	}
	if e := s.SaveLark(context.Background(), nextApp, "", "bot"); e == nil {
		t.Fatal("old app secret carried to another app")
	}
}
func TestCommittedNotDurableDoesNotRollback(t *testing.T) {
	s, c := harness(t, nil)
	c.mutationErr = &codedError{Code: "committed_not_durable", Message: "committed but not durable"}
	e := s.SaveLark(context.Background(), testApp, "synthetic-new-secret", nil)
	if e == nil {
		t.Fatal("uncertainty hidden")
	}
	if s.options.Store.Setting("lark_app_secret") != "synthetic-new-secret" {
		t.Fatal("committed credential rolled back")
	}
	secret, e := s.LarkSecret(context.Background())
	if e != nil || secret["app_secret"] != "synthetic-new-secret" {
		t.Fatal("core credential authority lost")
	}
	r := httptest.NewRecorder()
	writeError(r, c.mutationErr)
	if r.Code != 409 || !strings.Contains(r.Body.String(), "committed_not_durable") {
		t.Fatal(r.Body.String())
	}
}
func TestExportAndImportKeepSecretsOnPrivateDisk(t *testing.T) {
	var restored any
	var enabled []string
	s, c := harness(t, func(o *Options) {
		o.PullPreferences = func() (any, error) {
			return map[string]any{"follow": []any{map[string]any{"repository": "owner/repo", "follow": true}}}, nil
		}
		o.RestorePulls = func(v any) error { restored = v; return nil }
		o.Agents = func() (any, error) { return []any{map[string]any{"agent": "codex", "injected": true}}, nil }
		o.SetAgent = func(id string, on bool) (any, error) { enabled = append(enabled, id); return nil, nil }
	})
	out, e := s.ExportConfig(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "synthetic-old-secret") || strings.Contains(string(b), "synthetic-listener-token") {
		t.Fatal("export response leaks secrets")
	}
	path := text(out["path"])
	body, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(body), "synthetic-listener-token") {
		t.Fatal("full provider state omitted")
	}
	for path, want := range map[string]os.FileMode{path: 0600, s.exportsDir(): 0700} {
		info, e := os.Stat(path)
		if e != nil || info.Mode().Perm() != want {
			t.Fatalf("private export mode: %v %v", info, e)
		}
	}
	var imported map[string]any
	if e = json.Unmarshal(body, &imported); e != nil {
		t.Fatal(e)
	}
	summary, e := s.ImportConfig(context.Background(), imported)
	if e != nil {
		t.Fatal(e)
	}
	if restored == nil || len(enabled) != 1 || enabled[0] != "codex" || summary.ProviderCount == nil || *summary.ProviderCount != 1 {
		t.Fatalf("callbacks missing: %+v", summary)
	}
	if c.creds.AppSecret != "synthetic-old-secret" {
		t.Fatal("provider import did not preserve secret")
	}
	files, _ := os.ReadDir(s.exportsDir())
	if len(files) != 2 {
		t.Fatal("pre-import backup not created")
	}
	for i := 0; i < 12; i++ {
		if _, e = s.ExportConfig(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	files, _ = os.ReadDir(s.exportsDir())
	if len(files) != 10 {
		t.Fatalf("export retention: %d", len(files))
	}
}
func TestGetPagesNeverExposeSecretsAndSecretsRequirePost(t *testing.T) {
	s, _ := harness(t, func(o *Options) {
		o.GitHub = func(context.Context) (any, error) {
			return map[string]any{"account": map[string]any{"signedIn": false}, "login": map[string]any{"status": "waiting", "code": "PRIVATE-CODE", "url": "https://github.com/login/device"}}, nil
		}
	})
	for _, path := range []string{"/ui/api/settings", "/ui/api/settings/github", "/ui/api/settings/lark/secret"} {
		r := httptest.NewRecorder()
		s.Handler().ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if strings.Contains(r.Body.String(), "synthetic-old-secret") || strings.Contains(r.Body.String(), "PRIVATE-CODE") {
			t.Fatal("public page leaks secret")
		}
		if strings.HasSuffix(path, "/secret") && r.Code != 405 {
			t.Fatalf("GET secret status %d", r.Code)
		}
	}
	r := httptest.NewRecorder()
	s.Handler().ServeHTTP(r, httptest.NewRequest("POST", "/ui/api/settings/lark/secret", nil))
	if r.Code != 200 || !strings.Contains(r.Body.String(), "synthetic-old-secret") {
		t.Fatal("explicit POST did not reveal")
	}
}
func TestPermissionMetadataOnlyOffersOfficialScopedConsole(t *testing.T) {
	s, _ := harness(t, nil)
	p := permissionDetails(map[string]any{"code": 99991672, "msg": "need contact:user.base:readonly https://open.feishu.cn.evil.example/app/" + testApp + "/auth", "console_url": "https://open.feishu.cn/app/" + nextApp + "/auth", "error": map[string]any{"permission_violations": []any{map[string]any{"scope": "contact:contact.base:readonly", "subject": "im:message"}}}}, testApp)
	if p == nil || len(p.Scopes) != 2 || p.URL != "" {
		t.Fatalf("untrusted permission data: %+v", p)
	}
	help, e := s.permissionHelp(testApp, p, false)
	if e != nil {
		t.Fatal(e)
	}
	if !consoleURL(help.URL, testApp) {
		t.Fatal(help.URL)
	}
	raw, e := base64.StdEncoding.DecodeString(strings.TrimPrefix(help.QR, "data:image/png;base64,"))
	if e != nil {
		t.Fatal(e)
	}
	img, e := png.Decode(bytes.NewReader(raw))
	if e != nil || img.Bounds().Dx() != 184 {
		t.Fatal("permission QR is not native PNG")
	}
	b, _ := json.Marshal(help)
	if strings.Contains(string(b), "evil.example") || strings.Contains(string(b), nextApp) {
		t.Fatal("permission help leaked untrusted URL")
	}
}

func apiServer(t *testing.T, handler func(http.ResponseWriter, *http.Request)) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "tenant_access_token") {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "tenant_access_token": "synthetic-access-token", "expire": 7200})
			return
		}
		handler(w, r)
	}))
	t.Cleanup(upstream.Close)
	return upstream
}
func dataReply(w http.ResponseWriter, v any) {
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": v})
}
func TestRecipientStreamingCacheAndCredentialScope(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	upstream := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.URL.Path {
		case "/open-apis/contact/v3/scopes":
			ids := []string{}
			for i := 0; i < 51; i++ {
				ids = append(ids, fmt.Sprintf("ou_%d", i))
			}
			dataReply(w, map[string]any{"user_ids": ids})
		case "/open-apis/contact/v3/users/batch":
			ids := r.URL.Query()["user_ids"]
			if len(ids) == 1 {
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			items := []any{}
			for _, id := range ids {
				items = append(items, map[string]any{"open_id": id, "name": "Name " + id, "avatar": map[string]any{"avatar_72": "https://not-trusted.example/avatar"}})
			}
			dataReply(w, map[string]any{"items": items})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	s, c := harness(t, func(o *Options) { o.APIBaseURL = upstream.URL })
	host := httptest.NewServer(s.Handler())
	defer host.Close()
	res, e := http.Post(host.URL+"/ui/api/settings/lark/recipients/stream", "application/json", strings.NewReader(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	reader := bufio.NewReader(res.Body)
	line, e := reader.ReadBytes('\n')
	if e != nil {
		t.Fatal(e)
	}
	var event struct {
		Type      string    `json:"type"`
		Directory Directory `json:"directory"`
	}
	if json.Unmarshal(line, &event) != nil || event.Type != "progress" || len(event.Directory.Users) != 50 {
		t.Fatalf("not incremental: %s", line)
	}
	close(release)
	complete := false
	for {
		line, e = reader.ReadBytes('\n')
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		_ = json.Unmarshal(line, &event)
		if event.Type == "complete" {
			complete = true
			if len(event.Directory.Users) != 51 {
				t.Fatal("complete directory missing users")
			}
		}
	}
	_ = res.Body.Close()
	if !complete {
		t.Fatal("no terminal complete event")
	}
	before := calls.Load()
	d, e := s.Recipients(context.Background(), nil, false)
	if e != nil || !d.Cached || len(d.Users) != 51 || calls.Load() != before {
		t.Fatalf("fresh cache not used: %+v %v", d, e)
	}
	if d.Users[0].AvatarURL != "" {
		t.Fatal("untrusted avatar cached")
	}
	c.mu.Lock()
	c.creds.AppSecret = "rotated-secret"
	c.mu.Unlock()
	d, e = s.Recipients(context.Background(), nil, false)
	if e != nil || d.Cached || calls.Load() == before {
		t.Fatalf("cache crossed secret scope: %v", e)
	}
	info, e := os.Stat(filepath.Join(s.options.Store.Directory, "lark-directory-cache.json"))
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatal("directory cache is not private")
	}
}
func TestRecipientCancellationStopsRequestsWithoutCaching(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	upstream := apiServer(t, func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(cancelled) })
	s, _ := harness(t, func(o *Options) { o.APIBaseURL = upstream.URL })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, e := s.Recipients(ctx, nil, false); done <- e }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case e := <-done:
		if settingsError(e).Status != 499 {
			t.Fatalf("cancellation status: %v", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation hung")
	}
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("HTTP request not cancelled")
	}
	if _, e := os.Stat(s.cache.path); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("cancelled directory cached")
	}
}
func TestPermissionFailureClearsCacheAndStreamsActionableError(t *testing.T) {
	var denied atomic.Bool
	upstream := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
		if denied.Load() {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 99991672, "msg": "Required contact:user.base:readonly", "console_url": "https://evil.example/"})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/scopes") {
			dataReply(w, map[string]any{"user_ids": []string{"ou_one"}})
		} else {
			dataReply(w, map[string]any{"items": []any{map[string]any{"open_id": "ou_one", "name": "One"}}})
		}
	})
	s, _ := harness(t, func(o *Options) { o.APIBaseURL = upstream.URL })
	if _, e := s.Recipients(context.Background(), nil, false); e != nil {
		t.Fatal(e)
	}
	denied.Store(true)
	r := httptest.NewRecorder()
	s.Handler().ServeHTTP(r, httptest.NewRequest("POST", "/ui/api/settings/lark/recipients/stream", strings.NewReader(`{"refresh":true}`)))
	lines := strings.Split(strings.TrimSpace(r.Body.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected cached progress and failure, got %s", r.Body.String())
	}
	var last map[string]any
	_ = json.Unmarshal([]byte(lines[len(lines)-1]), &last)
	if last["type"] != "error" || number(last["status"]) != 403 {
		t.Fatal(last)
	}
	p := object(last["permission"])
	if !consoleURL(text(p["url"]), testApp) || !strings.HasPrefix(text(p["qr"]), "data:image/png;base64,") {
		t.Fatal("permission hint missing")
	}
	if _, e := os.Stat(s.cache.path); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("permission-revoked cache retained")
	}
	if strings.Contains(r.Body.String(), "evil.example") {
		t.Fatal("provider URL escaped filtering")
	}
}
func TestDirectoryRejectsStaleCredentialsDuringRefresh(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	upstream := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		dataReply(w, map[string]any{})
	})
	s, c := harness(t, func(o *Options) { o.APIBaseURL = upstream.URL })
	done := make(chan error, 1)
	go func() { _, e := s.Recipients(context.Background(), nil, false); done <- e }()
	<-started
	c.mu.Lock()
	c.creds = Credentials{nextApp, "next-secret"}
	c.mu.Unlock()
	close(release)
	if e := <-done; settingsError(e).Status != 409 {
		t.Fatalf("stale response accepted: %v", e)
	}
	if _, e := os.Stat(s.cache.path); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("stale response cached")
	}
}
