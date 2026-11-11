package pulls

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func transcriptFixture(t *testing.T, root, id, cwd string, records ...any) {
	t.Helper()
	dir := filepath.Join(root, "projects", encodeSegment.ReplaceAllString(cwd, "-"))
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	b := []byte{}
	for _, record := range records {
		line, _ := json.Marshal(record)
		b = append(append(b, line...), '\n')
	}
	if e := os.WriteFile(filepath.Join(dir, id+".jsonl"), b, 0600); e != nil {
		t.Fatal(e)
	}
}
func prLink(id string, n int) map[string]any {
	return map[string]any{"type": "pr-link", "sessionId": id, "prRepository": "team/project", "prNumber": n}
}
func TestDiscoveryStructuredLinksDesktopAliasesAndUnlink(t *testing.T) {
	root := t.TempDir()
	claude, desktop := filepath.Join(root, "claude"), filepath.Join(root, "desktop")
	profile := filepath.Join(desktop, "account", "profile")
	cwd := filepath.Join(root, "deleted-worktree")
	writeFixture(t, filepath.Join(profile, "local_a.json"), map[string]any{"sessionId": "local_a", "cliSessionId": "current", "priorCliSessionIds": []string{"prior"}, "title": "Desktop title", "cwd": cwd, "originCwd": "/original", "worktreePath": cwd, "gitAnchors": []any{map[string]any{"gitRoot": "/anchor"}}, "isArchived": false, "prs": []any{map[string]any{"url": "https://github.com/team/project/pull/12"}}})
	transcriptFixture(t, claude, "current", cwd, map[string]any{"cwd": cwd}, prLink("current", 99))
	transcriptFixture(t, claude, "prior", cwd, map[string]any{"cwd": cwd}, prLink("prior", 98))
	transcriptFixture(t, claude, "standalone", cwd, map[string]any{"cwd": cwd, "gitBranch": "fix", "message": "https://github.com/unrelated/repo/pull/8"}, prLink("standalone", 7), prLink("other", 88), prLink("standalone", 7))
	sources := Sources{ClaudeDir: claude, DesktopRoots: []string{desktop}}
	opts := DiscoveryOptions{Sources: &sources}
	result, e := DiscoverSources(context.Background(), opts)
	if e != nil || len(result.Warnings) != 0 || len(result.Sessions) != 2 {
		t.Fatalf("%+v %v", result, e)
	}
	first, second := result.Sessions[0], result.Sessions[1]
	if first.ID != "local_a" || len(first.Pulls) != 1 || first.Pulls[0].Number != 12 || !reflect.DeepEqual(first.Directories, []string{cwd, "/original", "/anchor"}) {
		t.Fatal(first)
	}
	if second.ID != "standalone" || len(second.Pulls) != 1 || second.Pulls[0].Number != 7 || second.Branch != "fix" {
		t.Fatal(second)
	}
	writeFixture(t, filepath.Join(profile, "local_a.json"), map[string]any{"sessionId": "local_a", "cliSessionId": "current", "priorCliSessionIds": []string{"prior"}, "cwd": cwd, "prs": []any{}})
	result, e = DiscoverSources(context.Background(), opts)
	if e != nil || len(result.Sessions[0].Pulls) != 0 {
		t.Fatal(result, e)
	}
	writeFixture(t, filepath.Join(profile, "local_a.json"), map[string]any{"sessionId": "local_a", "cliSessionId": "current", "priorCliSessionIds": []string{"prior"}, "cwd": cwd})
	result, e = DiscoverSources(context.Background(), opts)
	if e != nil || len(result.Sessions[0].Pulls) != 2 {
		t.Fatal(result, e)
	}
}
func TestDiscoveryCacheRefreshAndTranscriptOptOut(t *testing.T) {
	root := t.TempDir()
	d := &discoverer{}
	transcriptFixture(t, root, "s", "/gone", map[string]any{"cwd": "/gone"}, prLink("s", 1))
	sources := Sources{ClaudeDir: root}
	opts := DiscoveryOptions{Sources: &sources}
	first, e := d.discover(context.Background(), opts)
	if e != nil || len(first.Sessions[0].Pulls) != 1 {
		t.Fatal(first, e)
	}
	transcriptFixture(t, root, "s", "/gone", map[string]any{"cwd": "/gone"}, prLink("s", 22))
	second, e := d.discover(context.Background(), opts)
	if e != nil || second.Sessions[0].Pulls[0].Number != 22 {
		t.Fatal(second, e)
	}
	opts.IncludeTranscripts = boolptr(false)
	result, e := d.discover(context.Background(), opts)
	if e != nil || len(result.Sessions) != 1 || result.Sessions[0].Directory != "" || len(result.Sessions[0].Pulls) != 0 {
		t.Fatal(result, e)
	}
	// An unreadable Desktop catalog must not turn its unknown aliases into standalone CLI enrollment.
	invalid := filepath.Join(root, "invalid")
	if e = os.WriteFile(invalid, []byte("file"), 0600); e != nil {
		t.Fatal(e)
	}
	sources.DesktopRoots = []string{filepath.Join(invalid, "child")}
	result, e = d.discover(context.Background(), opts)
	if e != nil || len(result.Sessions) != 0 || len(result.Warnings) == 0 {
		t.Fatal(result, e)
	}
}
func TestDatabaseDiscoveryAndOpenCodeJSON(t *testing.T) {
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	if e := os.Mkdir(codex, 0700); e != nil {
		t.Fatal(e)
	}
	create := func(file, sqlText string) {
		t.Helper()
		db, e := sql.Open("sqlite", file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(sqlText); e != nil {
			t.Fatal(e)
		}
		if e = db.Close(); e != nil {
			t.Fatal(e)
		}
	}
	create(filepath.Join(codex, "state_4.sqlite"), `CREATE TABLE threads(id TEXT,cwd TEXT);INSERT INTO threads VALUES('old','/old');`)
	create(filepath.Join(codex, "state_5.sqlite"), `CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,name TEXT,git_branch TEXT,git_origin_url TEXT,updated_at INTEGER,archived INTEGER);INSERT INTO threads VALUES('t1','/a','Task','Name','fix','https://github.com/viewer/repo',1793000000,0),('t2','/a','Second',NULL,'other',NULL,1793100000,1);`)
	open := filepath.Join(root, "opencode")
	if e := os.Mkdir(open, 0700); e != nil {
		t.Fatal(e)
	}
	create(filepath.Join(open, "opencode.db"), `CREATE TABLE session(id TEXT,directory TEXT,title TEXT,time_updated INTEGER);INSERT INTO session VALUES('ses_1','/c','OpenCode',1793000000000);`)
	sources := Sources{CodexHome: codex, OpenCodeData: open}
	result, e := DiscoverSources(context.Background(), DiscoveryOptions{Sources: &sources})
	if e != nil || len(result.Sessions) != 3 {
		t.Fatal(result, e)
	}
	if result.Sessions[0].Title != "Name" || result.Sessions[0].Branch != "fix" || result.Sessions[0].Origin != "https://github.com/viewer/repo" || result.Sessions[0].Archived == nil || *result.Sessions[0].Archived || !(*result.Sessions[1].Archived) || result.Sessions[2].LastActive == "" {
		t.Fatal(result)
	}
	if e = os.Remove(filepath.Join(open, "opencode.db")); e != nil {
		t.Fatal(e)
	}
	writeFixture(t, filepath.Join(open, "storage", "session", "project", "ses_a.json"), map[string]any{"id": "ses_a", "title": "JSON", "directory": "/d", "time": map[string]any{"updated": 1793000001000}})
	result, e = DiscoverSources(context.Background(), DiscoveryOptions{Sources: &sources})
	if e != nil || result.Sessions[2].Title != "JSON" {
		t.Fatal(result, e)
	}
}
func TestPullReferencesRemoteParsingAndThreadFilters(t *testing.T) {
	for _, bad := range []string{"https://github.com.evil.test/a/b/pull/1", "https://user:pass@github.com/a/b/pull/1", "http://github.com/a/b/pull/1", "https://github.com/a/b/pull/0", "https://github.com/a/b/pull/9007199254740992"} {
		if p, ok := ParseGitHubPull(bad); ok {
			t.Fatal(p)
		}
	}
	p, ok := ParseGitHubPull("https://github.com/Owner/repo/pull/12/files?diff=split#L1")
	if !ok || p.URL != "https://github.com/Owner/repo/pull/12" {
		t.Fatal(p)
	}
	for _, remote := range []string{"https://user:pass@github.com/Owner/repo.git", "git@github.com:Owner/repo.git", "ssh://git@github.com/Owner/repo.git"} {
		if repo := ParseGitHubRemote(remote); repo != "Owner/repo" {
			t.Fatal(repo)
		}
	}
	if ParseGitHubRemote("https://github.com.evil.test/a/b") != "" {
		t.Fatal("external remote")
	}
	out := EligibleThreadSessions([]ConversationSession{{ID: "a", Adapter: "claude-desktop"}, {ID: "b", Adapter: "codex", Archived: boolptr(false), LastActive: "2"}, {ID: "c", Adapter: "codex", Archived: boolptr(true)}, {ID: "d", Adapter: "claude-code", LastActive: "3"}, {ID: "../e", Adapter: "opencode"}})
	if len(out) != 2 || out[0].ID != "d" || out[1].ID != "b" {
		t.Fatal(out)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	sources := Sources{ClaudeDir: strings.Repeat("x", 2)}
	_, e := DiscoverSources(ctx, DiscoveryOptions{Sources: &sources})
	if e != context.Canceled {
		t.Fatal(e)
	}
	root := t.TempDir()
	if e := os.MkdirAll(filepath.Join(root, "a-b", "c.d"), 0700); e != nil {
		t.Fatal(e)
	}
	path, e := DecodeProjectPath(context.Background(), "-a-b-c-d", root)
	if e != nil || path != filepath.Join(root, "a-b", "c.d") {
		t.Fatal(path, e)
	}
}
