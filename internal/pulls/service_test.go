package pulls

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeFixture(t *testing.T, path string, v any) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	data, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
}
func testPull(n int, repo string) PullRequest {
	return PullRequest{Number: n, URL: "https://github.com/" + repo + "/pull/" + fmtInt(n), Title: "Pull", Repository: repo, Author: "viewer", UpdatedAt: "2026-10-01T00:00:00Z", ReviewDecision: "UNKNOWN", Mergeable: "UNKNOWN", CI: CI{State: "UNKNOWN"}}
}
func fmtInt(n int) string { b, _ := json.Marshal(n); return string(b) }
func testCollection(pulls ...PullRequest) Collection {
	return Collection{Internal: nonNil(pulls), Upstream: []PullRequest{}, Warnings: []string{}, Scope: Scope{Authors: []string{"viewer"}, OwnedOwners: []string{"viewer"}}}
}
func eventually(t *testing.T, p func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !p() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(time.Millisecond)
	}
}
func settled(t *testing.T, s *Service) PullSnapshot {
	t.Helper()
	eventually(t, func() bool { return !s.Snapshot().Refresh.Running })
	return s.Snapshot()
}
func newTestService(t *testing.T, opts Options) *Service {
	t.Helper()
	if opts.StateDir == "" {
		opts.StateDir = filepath.Join(t.TempDir(), "state")
	}
	if opts.Sources == nil {
		opts.Sources = &Sources{}
	}
	s, e := New(opts)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}
func startTest(t *testing.T, s *Service) {
	t.Helper()
	if e := s.Start(context.Background()); e != nil {
		t.Fatal(e)
	}
}

func TestSessionSubscriptionsAndAssociations(t *testing.T) {
	root := t.TempDir()
	checkout := filepath.Join(root, "checkout")
	if e := os.Mkdir(checkout, 0700); e != nil {
		t.Fatal(e)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", checkout}, args...)...)
		if b, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("git: %s: %v", b, e)
		}
	}
	git("init", "-q")
	git("remote", "add", "origin", "https://github.com/viewer/active.git")
	git("remote", "add", "upstream", "https://github.com/External/Upstream.git")
	desktop := filepath.Join(root, "desktop")
	profile := filepath.Join(desktop, "account", "profile")
	writeFixture(t, filepath.Join(profile, "local_a.json"), map[string]any{"sessionId": "local_a", "title": "Fix login", "cwd": checkout, "branch": "new-branch", "prs": []any{map[string]any{"url": "https://github.com/external/direct/pull/9"}, map[string]any{"url": "https://github.com/viewer/active/pull/2"}}})
	writeFixture(t, filepath.Join(profile, "local_b.json"), map[string]any{"sessionId": "local_b", "title": "Feature", "cwd": checkout, "branch": "feature", "prs": []any{}})
	var mu sync.Mutex
	var targets Targets
	p1, p2 := testPull(1, "viewer/active"), testPull(2, "viewer/active")
	p1.HeadBranch = "feature"
	p2.HeadBranch = "feature"
	s := newTestService(t, Options{StateDir: filepath.Join(root, "state"), Sources: &Sources{DesktopRoots: []string{desktop}}, Collect: func(_ context.Context, _ Config, got Targets) (Collection, error) {
		mu.Lock()
		targets = clone(got)
		mu.Unlock()
		result := testCollection(p1, p2, testPull(99, "viewer/unrelated"))
		result.Upstream = []PullRequest{testPull(9, "external/direct")}
		return result, nil
	}})
	startTest(t, s)
	snapshot := settled(t, s)
	if len(snapshot.Repositories) != 3 || len(snapshot.Internal) != 2 || len(snapshot.Upstream) != 1 || snapshot.Hidden.Internal != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	if snapshot.Internal[0].Subscription != "session-branch" || snapshot.Internal[0].Sessions[0].ID != "local_b" || snapshot.Internal[1].Subscription != "session-pr" || snapshot.Internal[1].Sessions[0].ID != "local_a" {
		t.Fatalf("wrong associations %+v", snapshot.Internal)
	}
	for _, entry := range snapshot.Repositories {
		if entry.Repository == "external/direct" && (entry.AllPulls || entry.LinkedPulls != 1) {
			t.Fatalf("linked PR invented repository subscription: %+v", entry)
		}
	}
	mu.Lock()
	got := clone(targets)
	mu.Unlock()
	if !has(got.Repositories, "viewer/active") || !has(got.Repositories, "External/Upstream") || has(got.Repositories, "external/direct") || !reflect.DeepEqual(got.LocalForks, []string{"viewer/active"}) {
		t.Fatalf("wrong targets %+v", got)
	}
	snapshot.Repositories[0].Sources = nil
	if len(s.Repositories()[0].Sources) == 0 {
		t.Fatal("snapshot mutated service")
	}
}
func TestCacheChoiceAndRefreshFailure(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	var fail bool
	var mu sync.Mutex
	discovery := func(context.Context) (DiscoveryResult, error) {
		return DiscoveryResult{Sessions: []ConversationSession{{ID: "s", Agent: "codex", Adapter: "codex", Title: "task", Origin: "https://github.com/viewer/repo", Pulls: []PullReference{}}}}, nil
	}
	collector := func(context.Context, Config, Targets) (Collection, error) {
		mu.Lock()
		f := fail
		mu.Unlock()
		if f {
			return Collection{}, errors.New("HTTP 403 ghp_privateToken")
		}
		return testCollection(testPull(1, "viewer/repo")), nil
	}
	s := newTestService(t, Options{StateDir: dir, Discover: discovery, Collect: collector})
	startTest(t, s)
	good := settled(t, s)
	if len(good.Internal) != 1 {
		t.Fatal(good)
	}
	cache, e := os.ReadFile(filepath.Join(dir, "pulls-cache.json"))
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"pulls-cache.json"} {
		st, e := os.Stat(filepath.Join(dir, name))
		if e != nil || st.Mode().Perm()&0077 != 0 {
			t.Fatalf("cache permissions: %v %v", st, e)
		}
	}
	mu.Lock()
	fail = true
	mu.Unlock()
	s.Refresh()
	failed := settled(t, s)
	if len(failed.Internal) != 1 || s.Status() != "stale" || strings.Contains(failed.Refresh.Error, "privateToken") {
		t.Fatal(failed)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "pulls-cache.json"))
	if string(cache) != string(after) {
		t.Fatal("failed refresh replaced good cache")
	}
	entry, e := s.SetChoice("VIEWER/REPO", boolptr(false))
	if e != nil || entry.Choice != "mute" {
		t.Fatalf("choice: %+v %v", entry, e)
	}
	settled(t, s)
	_ = s.Close()
	restarted := newTestService(t, Options{StateDir: dir, Sources: &Sources{}})
	snap := restarted.Snapshot()
	if len(snap.Internal) != 0 || snap.Repositories[0].Choice != "mute" || snap.Refresh.Running {
		t.Fatal(snap)
	}
	reset, e := restarted.SetChoice("viewer/repo", boolptr(true))
	if e != nil || reset.Choice != "" || !reset.Followed {
		t.Fatalf("reset: %+v %v", reset, e)
	}
}
func TestLegacyCacheCannotInventRepositories(t *testing.T) {
	dir := t.TempDir()
	for _, version := range []int{1, 2} {
		writeFixture(t, filepath.Join(dir, "pulls-cache.json"), map[string]any{"version": version, "snapshot": map[string]any{"internal": []any{testPull(1, "viewer/unrelated")}, "involved": []any{map[string]any{"repository": "viewer/unrelated"}}}})
		s := newTestService(t, Options{StateDir: dir})
		if snap := s.Snapshot(); len(snap.Repositories) != 0 || len(snap.Internal) != 0 || len(snap.Warnings) == 0 {
			t.Fatal(snap)
		}
	}
}
func TestRefreshQueueCancellationAndSignedOut(t *testing.T) {
	gate := make(chan struct{})
	entered := make(chan Targets, 8)
	var mu sync.Mutex
	count := 0
	blockCancel := false
	source := func(context.Context) (DiscoveryResult, error) {
		return DiscoveryResult{Sessions: []ConversationSession{{ID: "s", Agent: "codex", Adapter: "codex", Origin: "https://github.com/viewer/repo", Pulls: []PullReference{}}}}, nil
	}
	s := newTestService(t, Options{Discover: source, Collect: func(ctx context.Context, _ Config, targets Targets) (Collection, error) {
		mu.Lock()
		count++
		n := count
		block := blockCancel
		mu.Unlock()
		entered <- targets
		if n == 1 {
			select {
			case <-gate:
			case <-ctx.Done():
				return Collection{}, ctx.Err()
			}
			return Collection{}, ErrSignedOut
		}
		if block {
			<-ctx.Done()
			return Collection{}, ctx.Err()
		}
		return testCollection(testPull(1, "viewer/repo")), nil
	}})
	startTest(t, s)
	<-entered
	for i := 0; i < 8; i++ {
		s.Refresh()
	}
	if _, e := s.SetChoice("viewer/repo", boolptr(false)); e != nil {
		t.Fatal(e)
	}
	close(gate)
	select {
	case targets := <-entered:
		if len(targets.Repositories) != 0 {
			t.Fatal(targets)
		}
	case <-time.After(time.Second):
		t.Fatal("no queued refresh")
	}
	snapshot := settled(t, s)
	if snapshot.Refresh.SignedOut || snapshot.Refresh.Error != "" {
		t.Fatal(snapshot.Refresh)
	}
	mu.Lock()
	n := count
	blockCancel = true
	mu.Unlock()
	if n != 2 {
		t.Fatal(n)
	}
	s.Refresh()
	<-entered
	done := make(chan struct{})
	go func() { _ = s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close failed to cancel")
	}
	if s.Status() != "stopped" {
		t.Fatal(s.Status())
	}
}
func TestIncompleteCoverageRetainsOnlyUnobservedSubscribedCache(t *testing.T) {
	var mu sync.Mutex
	partial := false
	s := newTestService(t, Options{Discover: func(context.Context) (DiscoveryResult, error) {
		return DiscoveryResult{Sessions: []ConversationSession{{ID: "s", Agent: "codex", Adapter: "codex", Origin: "https://github.com/viewer/repo", Pulls: []PullReference{}}}}, nil
	}, Collect: func(context.Context, Config, Targets) (Collection, error) {
		mu.Lock()
		p := partial
		mu.Unlock()
		if !p {
			return testCollection(testPull(1, "viewer/repo"), testPull(2, "viewer/repo")), nil
		}
		r := testCollection()
		r.IncompleteInternal = true
		r.ObservedURLs = []string{"https://github.com/viewer/repo/pull/1"}
		return r, nil
	}})
	startTest(t, s)
	settled(t, s)
	mu.Lock()
	partial = true
	mu.Unlock()
	s.Refresh()
	snap := settled(t, s)
	if len(snap.Internal) != 1 || snap.Internal[0].Number != 2 || !strings.Contains(strings.Join(snap.Warnings, " "), "retained 1") {
		t.Fatal(snap)
	}
}
func TestUIEndpointShapes(t *testing.T) {
	s := newTestService(t, Options{})
	handler := s.UIHandler()
	request := func(method, path, body string, header bool) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if header {
			r.Header.Set("x-nootify-ui", "1")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	w := request("GET", "/ui/api/pulls", "", false)
	const empty = `{"internal":[],"upstream":[],"hidden":{"internal":0,"upstream":0},"repositories":[],"refresh":{"running":false},"warnings":[]}`
	var got, want any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	_ = json.Unmarshal([]byte(empty), &want)
	if w.Code != 200 || !reflect.DeepEqual(got, want) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w = request("POST", "/ui/api/pulls/refresh", "", false); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w = request("POST", "/ui/api/pulls/refresh", "", true); w.Code != 202 || strings.TrimSpace(w.Body.String()) != `{"accepted":true}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{"repository":"bad repo","follow":true}`, `{"repository":"viewer/manual","follow":"true"}`, `{"repository":"viewer/manual"}`, `[]`, `{broken`} {
		if w = request("POST", "/ui/api/repos", body, true); w.Code != 400 {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body)
		}
	}
	w = request("POST", "/ui/api/repos", `{"repository":"viewer/manual","follow":true}`, true)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var entry RepositoryEntry
	if json.Unmarshal(w.Body.Bytes(), &entry) != nil || entry.Repository != "viewer/manual" || !entry.Followed || !entry.AllPulls || entry.Choice != "follow" || entry.Sources == nil || entry.Agents == nil {
		t.Fatal(w.Body.String())
	}
	w = request("GET", "/ui/api/repos", "", false)
	if w.Code != 200 || !strings.HasPrefix(w.Body.String(), "[") {
		t.Fatal(w.Body.String())
	}
	if w = request("POST", "/ui/api/repos", strings.Repeat("a", 4097), true); w.Code != 413 {
		t.Fatal(w.Code)
	}
	p := testPull(1, "viewer/manual")
	p.Subscription = "manual"
	b, _ := json.Marshal(p)
	if !strings.Contains(string(b), `"sessions":[]`) {
		t.Fatal(string(b))
	}
}
func TestSnapshotDoesNotBlockOnNetwork(t *testing.T) {
	entered := make(chan struct{})
	s := newTestService(t, Options{Collect: func(ctx context.Context, _ Config, _ Targets) (Collection, error) {
		close(entered)
		<-ctx.Done()
		return Collection{}, ctx.Err()
	}})
	startTest(t, s)
	<-entered
	done := make(chan struct{})
	go func() {
		s.Snapshot()
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/ui/api/pulls/refresh", nil)
		r.Header.Set("x-nootify-ui", "1")
		s.UIHandler().ServeHTTP(w, r)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("snapshot blocked on refresh")
	}
}
func TestNoTokenIsSignedOutWithoutHTTP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("request without token")
		io.WriteString(w, `{}`)
	}))
	defer server.Close()
	s := newTestService(t, Options{GraphQLURL: server.URL})
	startTest(t, s)
	snap := settled(t, s)
	if !snap.Refresh.SignedOut || snap.Refresh.Error != "" || s.Status() != "signed_out" {
		t.Fatal(snap)
	}
}
