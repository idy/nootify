package discovery

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
func writeFixture(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
}
func TestDiscoveryDesktopAliasesAndSessionMetadata(t *testing.T) {
	root := t.TempDir()
	claude, desktop := filepath.Join(root, "claude"), filepath.Join(root, "desktop")
	profile := filepath.Join(desktop, "account", "profile")
	cwd := filepath.Join(root, "deleted-worktree")
	writeFixture(t, filepath.Join(profile, "local_a.json"), map[string]any{"sessionId": "local_a", "cliSessionId": "current", "priorCliSessionIds": []string{"prior"}, "title": "Desktop title", "cwd": cwd, "originCwd": "/original", "worktreePath": cwd, "gitAnchors": []any{map[string]any{"gitRoot": "/anchor"}}, "isArchived": false})
	transcriptFixture(t, claude, "current", cwd, map[string]any{"cwd": cwd})
	transcriptFixture(t, claude, "prior", cwd, map[string]any{"cwd": cwd})
	transcriptFixture(t, claude, "standalone", cwd, map[string]any{"cwd": cwd, "gitBranch": "fix"}, map[string]any{"type": "custom-title", "customTitle": "CLI title"})
	sources := Sources{ClaudeDir: claude, DesktopRoots: []string{desktop}}
	for _, include := range []bool{true, false} {
		result, err := DiscoverSources(context.Background(), DiscoveryOptions{Sources: &sources, IncludeTranscripts: &include})
		if err != nil || len(result.Warnings) != 0 || len(result.Sessions) != 2 {
			t.Fatalf("%+v %v", result, err)
		}
		first, second := result.Sessions[0], result.Sessions[1]
		if first.ID != "local_a" || first.Title != "Desktop title" || !reflect.DeepEqual(first.Directories, []string{cwd, "/original", "/anchor"}) {
			t.Fatal(first)
		}
		if second.ID != "standalone" || (include && (second.Branch != "fix" || second.Title != "CLI title")) {
			t.Fatal(second)
		}
	}
}
func TestDiscoveryCacheRefreshAndTranscriptOptOut(t *testing.T) {
	root := t.TempDir()
	d := &discoverer{}
	transcriptFixture(t, root, "s", "/gone", map[string]any{"cwd": "/gone", "gitBranch": "old"})
	sources := Sources{ClaudeDir: root}
	opts := DiscoveryOptions{Sources: &sources}
	first, e := d.discover(context.Background(), opts)
	if e != nil || len(first.Sessions) != 1 || first.Sessions[0].Branch != "old" {
		t.Fatal(first, e)
	}
	transcriptFixture(t, root, "s", "/gone", map[string]any{"cwd": "/gone", "gitBranch": "updated"})
	second, e := d.discover(context.Background(), opts)
	if e != nil || second.Sessions[0].Branch != "updated" {
		t.Fatal(second, e)
	}
	opts.IncludeTranscripts = boolptr(false)
	result, e := d.discover(context.Background(), opts)
	if e != nil || len(result.Sessions) != 1 || result.Sessions[0].Directory != "" || result.Sessions[0].Branch != "" {
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
func TestThreadFiltersCancellationAndProjectPaths(t *testing.T) {
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
