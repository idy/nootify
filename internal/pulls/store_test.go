package pulls

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestConfigPreferencesRestoreAndLimits(t *testing.T) {
	home := t.TempDir()
	config, e := ParseConfig([]byte(`{"authors":["Extra","extra"],"ownedOwners":["OurOrg"],"scanRoots":["~/Repos","~\\Repos","~/repos"],"maxScanDepth":1e2,"maxUpstreamPages":2.0,"followDefault":"all"}`), home)
	if e != nil || !reflect.DeepEqual(config.Authors, []string{"extra"}) || !reflect.DeepEqual(config.ScanRoots, []string{filepath.Join(home, "Repos"), filepath.Join(home, "repos")}) || config.MaxScanDepth != 20 || config.MaxUpstreamPages != 2 {
		t.Fatal(config, e)
	}
	for _, value := range []string{`null`, `[]`, `{"authors":[null]}`, `{"authors":["bad login"]}`, `{"scanRoots":["relative"]}`, `{"excludeRepositories":["a/b.git"]}`, `{"maxUpstreamPages":0}`, `{"maxUpstreamPages":1.5}`, `{"followDefault":"other"}`} {
		if _, e = ParseConfig([]byte(value), home); e == nil {
			t.Fatal("accepted", value)
		}
	}
	s := newTestService(t, Options{Home: home})
	preferences := Preferences{Config: json.RawMessage(`{"ownedOwners":["OurOrg"],"refreshMinutes":1}`), Follow: []FollowChoice{{"viewer/manual", true}, {"viewer/muted", false}}}
	if e = s.Restore(preferences); e != nil {
		t.Fatal(e)
	}
	saved, e := s.Preferences()
	if e != nil || !reflect.DeepEqual(saved.Follow, preferences.Follow) {
		t.Fatal(saved, e)
	}
	loaded, source, warnings, e := loadConfig(s.opts.StateDir, home)
	if e != nil || source == "defaults" || len(warnings) != 1 || !reflect.DeepEqual(loaded.OwnedOwners, []string{"OurOrg"}) {
		t.Fatal(loaded, source, warnings, e)
	}
	before, _ := os.ReadFile(filepath.Join(s.opts.StateDir, "repo-preferences.json"))
	if e = s.Restore(Preferences{Config: json.RawMessage(`{"authors":["bad login"]}`), Follow: []FollowChoice{}}); e == nil {
		t.Fatal("invalid restore accepted")
	}
	after, _ := os.ReadFile(filepath.Join(s.opts.StateDir, "repo-preferences.json"))
	if string(before) != string(after) {
		t.Fatal("invalid restore mutated choices")
	}
	if e = s.Restore(Preferences{Follow: []FollowChoice{}}); e != nil {
		t.Fatal(e)
	}
	if len(s.Repositories()) != 0 {
		t.Fatal(s.Repositories())
	}
	explicit := filepath.Join(home, "alternate.json")
	writeFixture(t, explicit, map[string]any{"ownedOwners": []string{"Alternate"}})
	t.Setenv("NOOTIFY_PULLS_CONFIG", explicit)
	loaded, source, _, e = loadConfig(s.opts.StateDir, home)
	if e != nil || source != explicit || loaded.OwnedOwners[0] != "Alternate" {
		t.Fatal(loaded, e)
	}
}
func TestCacheValidationRejectsMalformedFieldsAndSupportsAlternateName(t *testing.T) {
	cache := collected{Internal: []PullRequest{testPull(1, "viewer/repo")}, Upstream: []PullRequest{}, Involved: []involvement{{Repository: "viewer/repo", Sources: []RepositorySession{{SessionReference: SessionReference{ID: "s", Name: "Task", Agent: "codex", Adapter: "codex"}, Directory: "/a", FromRepository: true, Pulls: []PullReference{}}}}}, LocalForks: []string{}, Authors: []string{"viewer"}, Refresh: RefreshState{Running: true, LastSuccessAt: "2026-10-01T00:00:00Z"}, Warnings: []string{}}
	envelope := map[string]any{"version": 3, "snapshot": cache}
	b, _ := json.Marshal(envelope)
	loaded, ok := validCache(b)
	if !ok || loaded.Refresh.Running {
		t.Fatal(ok, loaded)
	}
	for _, field := range []string{"ci.state", "ci.total", "isDraft", "source.fromRepository", "source.archived", "source.branch", "source.lastActive", "authors", "warnings", "refresh.running"} {
		t.Run(field, func(t *testing.T) {
			var root map[string]any
			_ = json.Unmarshal(b, &root)
			snapshot := object(root["snapshot"])
			pull := object(array(snapshot["internal"])[0])
			source := object(array(object(array(snapshot["involved"])[0])["sources"])[0])
			switch {
			case strings.HasPrefix(field, "ci."):
				object(pull["ci"])[strings.TrimPrefix(field, "ci.")] = nil
			case strings.HasPrefix(field, "source."):
				source[strings.TrimPrefix(field, "source.")] = nil
			case field == "isDraft":
				pull[field] = nil
			case field == "refresh.running":
				object(snapshot["refresh"])["running"] = nil
			default:
				snapshot[field] = []any{nil}
			}
			bad, _ := json.Marshal(root)
			if _, ok := validCache(bad); ok {
				t.Fatalf("accepted %s: %s", field, bad)
			}
		})
	}
	dir := t.TempDir()
	writeFixture(t, filepath.Join(dir, "pulls.json"), envelope)
	s := newTestService(t, Options{StateDir: dir})
	if len(s.Snapshot().Internal) != 1 || s.Snapshot().Refresh.Running {
		t.Fatal(s.Snapshot())
	}
}
func TestRefreshRunningIncludesPersistenceAndReportCleanup(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	s := newTestService(t, Options{Collect: func(context.Context, Config, Targets) (Collection, error) { return testCollection(), nil }, Report: func(map[string]any) { close(entered); <-release }})
	startTest(t, s)
	<-entered
	cache, e := os.ReadFile(filepath.Join(s.opts.StateDir, "pulls-cache.json"))
	if e != nil {
		close(release)
		t.Fatal(e)
	}
	if !s.Snapshot().Refresh.Running || len(cache) == 0 {
		close(release)
		t.Fatal("refresh completed before its cleanup")
	}
	close(release)
	settled(t, s)
}
