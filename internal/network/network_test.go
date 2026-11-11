package network

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/idy/nootify/internal/storage"
	"github.com/idy/nootify/native/tailscale"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

type fakeEmbedded struct {
	mu                              sync.Mutex
	status                          tailscale.StatusResult
	statusErr                       error
	who                             func(string) *apitype.WhoIsResponse
	starts, closes, logins, logouts int
	publications                    []string
	unpublished                     []int
	done                            chan struct{}
	once                            sync.Once
}

func newFake() *fakeEmbedded {
	return &fakeEmbedded{done: make(chan struct{}), status: tailscale.StatusResult{BackendState: "NeedsLogin"}}
}
func (f *fakeEmbedded) Start(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	return nil
}
func (f *fakeEmbedded) Close() error {
	f.once.Do(func() { f.mu.Lock(); f.closes++; f.mu.Unlock(); close(f.done) })
	return nil
}
func (f *fakeEmbedded) Done() <-chan struct{} { return f.done }
func (f *fakeEmbedded) Err() error            { return nil }
func (f *fakeEmbedded) Status(context.Context) (tailscale.StatusResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status, f.statusErr
}
func (f *fakeEmbedded) Login(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logins++
	return nil
}
func (f *fakeEmbedded) Logout(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logouts++
	return nil
}
func (f *fakeEmbedded) WhoIs(_ context.Context, ip string) (*apitype.WhoIsResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.who != nil {
		return f.who(ip), nil
	}
	return nil, errors.New("peer_not_found")
}
func (f *fakeEmbedded) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("synthetic_dial")
}
func (f *fakeEmbedded) Publish(_ context.Context, port int, target string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.publications = append(f.publications, fmt.Sprintf("%d:%s", port, target))
	return nil
}
func (f *fakeEmbedded) Unpublish(_ context.Context, port int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unpublished = append(f.unpublished, port)
	return nil
}

func harness(t *testing.T, node *fakeEmbedded, handler http.Handler, call func(context.Context, string, any) (any, error)) (*Service, *storage.Store) {
	t.Helper()
	store, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if handler == nil {
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	}
	s, err := New(Options{Store: store, Handler: handler, Core: call})
	if err != nil {
		t.Fatal(err)
	}
	s.factory = func(tailscale.Config) (embedded, error) { return node, nil }
	if err = s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, store
}
func enable(t *testing.T, s *Service) {
	t.Helper()
	value := true
	if _, err := s.Action(context.Background(), "enable", &value); err != nil {
		t.Fatal(err)
	}
}
func runningStatus() tailscale.StatusResult {
	return tailscale.StatusResult{BackendState: "Running", NootifyListening: true, Self: &tailscale.SelfStatus{DNSName: "nootify.example.ts.net.", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.1")}, UserID: 1}, User: map[tailcfg.UserID]tailcfg.UserProfile{1: {LoginName: "owner@example.com"}}}
}

func TestPageLoginPersistenceAndCancel(t *testing.T) {
	node := newFake()
	node.status.AuthURL = "https://login.tailscale.com/a/Abc123"
	s, store := harness(t, node, nil, nil)
	page, _ := s.Page(context.Background())
	if page["status"] != "disabled" {
		t.Fatal(page)
	}
	result, err := s.Action(context.Background(), "login", nil)
	if err != nil {
		t.Fatal(err)
	}
	login := result.(loginState)
	if login.Status != "waiting" || login.URL != "https://login.tailscale.com/a/Abc123" || node.logins != 0 || !store.BoolSetting("tailscale_enabled", false) {
		t.Fatalf("first enrollment changed: %#v", result)
	}
	page, _ = s.Page(context.Background())
	if page["status"] != "needs-login" || page["deviceName"] != "nootify" || page["sharing"] != "starting" {
		t.Fatal(page)
	}
	if _, err = s.Action(context.Background(), "cancel", nil); err != nil {
		t.Fatal(err)
	}
	page, _ = s.Page(context.Background())
	if page["enabled"] != false || page["status"] != "disabled" || store.BoolSetting("tailscale_enabled", true) || node.closes != 1 {
		t.Fatal(page)
	}
}

func TestLoginURLAllowlist(t *testing.T) {
	for _, raw := range []string{"http://login.tailscale.com/a/abc", "https://login.tailscale.com.evil/a/abc", "https://login.tailscale.com:443/a/abc", "https://x@login.tailscale.com/a/abc", "https://login.tailscale.com/a/abc?q=1", "https://login.tailscale.com/a/abc#x", "https://login.tailscale.com/a/a%62c"} {
		if loginURL(raw) != "" {
			t.Fatal(raw)
		}
	}
	if loginURL("https://login.tailscale.com/a/ABC123") == "" {
		t.Fatal("valid official URL rejected")
	}
}

func TestStatusFailuresAreBoundedAndErrorsSanitized(t *testing.T) {
	node := newFake()
	s, _ := harness(t, node, nil, nil)
	enable(t, s)
	node.mu.Lock()
	node.statusErr = errors.New("status_failed")
	node.mu.Unlock()
	for range 2 {
		if err := s.Sync(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if node.closes != 0 {
		t.Fatal("transient status failure restarted node too early")
	}
	_ = s.Sync(context.Background())
	page, _ := s.Page(context.Background())
	if node.closes != 1 || page["error"] != "status_failed" || page["status"] != "unavailable" {
		t.Fatal(page)
	}
	_ = s.Sync(context.Background())
	if node.starts != 1 {
		t.Fatal("restart ignored 30 second cooldown")
	}
	s.op.Lock()
	s.retryAt = time.Time{}
	s.factory = func(tailscale.Config) (embedded, error) { return nil, errors.New("private auth key") }
	s.op.Unlock()
	_ = s.Sync(context.Background())
	page, _ = s.Page(context.Background())
	if page["error"] != "embedded_request_failed" {
		t.Fatal(page)
	}
}

func TestReconcileRemotePublicationAndEncryptedCoreFlag(t *testing.T) {
	node := newFake()
	node.status = runningStatus()
	remote := map[string]any{"enabled": true, "listen": "0.0.0.0:7443"}
	var flags []bool
	call := func(_ context.Context, method string, params any) (any, error) {
		switch method {
		case "transport.configure":
			flags = append(flags, params.(map[string]any)["tailnet_enabled"].(bool))
			return map[string]any{}, nil
		case "status":
			return map[string]any{"remote": remote}, nil
		default:
			t.Errorf("unexpected recursive core method: %s", method)
			return nil, errors.New("bad method")
		}
	}
	s, _ := harness(t, node, nil, call)
	enable(t, s)
	if len(node.publications) != 1 || node.publications[0] != "7443:127.0.0.1:7443" || s.URL() != "http://100.64.0.1/" {
		t.Fatal(node.publications, s.URL())
	}
	remote["listen"] = "[::]:7444"
	if err := s.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(node.unpublished) != 1 || node.unpublished[0] != 7443 || node.publications[1] != "7444:[::1]:7444" {
		t.Fatal(node.publications, node.unpublished)
	}
	remote["enabled"] = false
	if err := s.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(node.unpublished) != 2 || node.unpublished[1] != 7444 {
		t.Fatal(node.unpublished)
	}
	if _, err := s.Action(context.Background(), "cancel", nil); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(flags) != "[false true false]" {
		t.Fatal(flags)
	}
}

func TestPreferenceFailureDoesNotEnableAndLogoutAlwaysCloses(t *testing.T) {
	node := newFake()
	s, store := harness(t, node, nil, nil)
	_ = store.Close()
	value := true
	if _, err := s.Action(context.Background(), "enable", &value); err == nil || node.starts != 0 {
		t.Fatal("enabled before persistence")
	}
	node2 := newFake()
	s2, store2 := harness(t, node2, nil, nil)
	enable(t, s2)
	_ = store2.Close()
	if _, err := s2.Action(context.Background(), "logout", nil); err == nil || node2.closes != 1 || node2.logouts != 1 {
		t.Fatal("logout persistence failure retained signed-out device")
	}
	page, _ := s2.Page(context.Background())
	if page["enabled"] != false || page["status"] != "disabled" {
		t.Fatal(page)
	}
}

func proxyGet(t *testing.T, s *Service, peer, host, path, extra string) int {
	t.Helper()
	return proxyRequest(t, s, "GET", peer, host, path, extra)
}

func proxyRequest(t *testing.T, s *Service, method, peer, host, path, extra string) int {
	t.Helper()
	conn, err := net.Dial("tcp", s.proxy.ingress.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, err = fmt.Fprintf(conn, "PROXY TCP4 %s 100.64.0.1 54321 80\r\n%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n%s\r\n", peer, method, path, host, extra)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode
}

func TestTailnetProxyAuthenticatesPeerAndHostAndMarksReadonlyRequests(t *testing.T) {
	node := newFake()
	node.status = runningStatus()
	node.who = func(ip string) *apitype.WhoIsResponse {
		login := "owner@example.com"
		tags := []string(nil)
		if ip == "100.64.0.3" {
			login = "other@example.com"
		}
		if ip == "100.64.0.4" {
			tags = []string{"tag:server"}
		}
		return &apitype.WhoIsResponse{Node: &tailcfg.Node{Tags: tags}, UserProfile: &tailcfg.UserProfile{LoginName: login}}
	}
	var handled int
	s, _ := harness(t, node, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handled++
		if !IsTailnet(r) || !strings.HasPrefix(r.RemoteAddr, "100.64.0.2:") {
			t.Error("trusted peer provenance missing")
		}
		w.WriteHeader(204)
	}), nil)
	enable(t, s)
	if code := proxyGet(t, s, "100.64.0.2", "nootify.example.ts.net", "/ui/api/snapshot", ""); code != 204 {
		t.Fatal(code)
	}
	for _, tc := range []struct{ peer, host, path, extra string }{
		{"100.64.0.2", "evil.example", "/", ""},
		{"100.64.0.3", "100.64.0.1", "/", "X-Forwarded-For: 100.64.0.2\r\n"},
		{"100.64.0.4", "100.64.0.1", "/", ""},
		{"100.64.0.2", "100.64.0.1", "/v1/sessions", "Authorization: Bearer secret\r\n"},
		{"100.64.0.2", "100.64.0.1", "/ui/api/secure", ""},
		{"100.64.0.2", "100.64.0.1", "/ui/api/settings/export", ""},
		{"100.64.0.2", "100.64.0.1", "/", "Origin: http://evil.example\r\n"},
	} {
		if code := proxyGet(t, s, tc.peer, tc.host, tc.path, tc.extra); code != 403 {
			t.Fatalf("unauthorized request passed: %#v = %d", tc, code)
		}
	}
	if handled != 1 {
		t.Fatalf("handler saw unauthorized requests: %d", handled)
	}
	for _, path := range []string{"/ui/api/pulls/refresh", "/ui/api/repos"} {
		if code := proxyRequest(t, s, "POST", "100.64.0.2", "100.64.0.1", path, "X-Nootify-Ui: 1\r\nOrigin: http://100.64.0.1\r\n"); code != 204 {
			t.Fatalf("existing Tailnet page action rejected: %s = %d", path, code)
		}
		if code := proxyRequest(t, s, "POST", "100.64.0.2", "100.64.0.1", path, ""); code != 403 {
			t.Fatalf("Tailnet page action accepted without UI header: %s = %d", path, code)
		}
	}
	if code := proxyRequest(t, s, "POST", "100.64.0.2", "100.64.0.1", "/ui/api/settings/tailscale", "X-Nootify-Ui: 1\r\n"); code != 403 {
		t.Fatalf("Tailnet settings mutation accepted: %d", code)
	}
	if IsTailnet(&http.Request{}) {
		t.Fatal("ordinary request marked trusted")
	}
}

func TestProxyRequiresBoundedCompleteHeader(t *testing.T) {
	for _, header := range []string{"GET / HTTP/1.1\r\n", strings.Repeat("x", 109), "PROXY TCP4 100.64.0.2 100.64.0.1 0 80\r\n", "PROXY UNKNOWN\r\n", "PROXY TCP4 100.64.0.2 100.64.0.1 54321 80\n"} {
		p, err := newProxyIngress()
		if err != nil {
			t.Fatal(err)
		}
		conn, err := net.Dial("tcp", p.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		_, _ = io.WriteString(conn, header)
		if _, err = conn.Read(make([]byte, 1)); err == nil {
			t.Fatal("invalid prefix was accepted")
		}
		_ = conn.Close()
		_ = p.Close()
	}
}
