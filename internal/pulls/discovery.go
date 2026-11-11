package pulls

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/idy/nootify/internal/storage"
	_ "modernc.org/sqlite"
)

const maxSessions = 10000

// Sources can select only a subset of clients. A nil Options.Sources uses DefaultSources.
type Sources struct {
	ClaudeDir    string
	DesktopRoots []string
	CodexHome    string
	OpenCodeData string
}
type ConversationSession struct {
	ID          string          `json:"id"`
	Agent       string          `json:"agent"`
	Adapter     string          `json:"adapter"`
	Title       string          `json:"title"`
	Directory   string          `json:"directory"`
	Directories []string        `json:"directories"`
	Branch      string          `json:"branch,omitempty"`
	Origin      string          `json:"origin,omitempty"`
	Archived    *bool           `json:"archived,omitempty"`
	LastActive  string          `json:"lastActive,omitempty"`
	Pulls       []PullReference `json:"pulls"`
}
type DiscoveryOptions struct {
	Home               string
	Sources            *Sources
	IncludeTranscripts *bool
}
type DiscoveryResult struct {
	Sessions []ConversationSession
	Warnings []string
}
type transcriptMeta struct {
	Directory, Title, Branch string
	Pulls                    []PullReference
}
type transcriptEntry struct {
	size     int64
	modified time.Time
	meta     transcriptMeta
}
type discoverer struct {
	mu          sync.Mutex
	transcripts map[string]transcriptEntry
}

func DefaultSources(home string) Sources {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	env := func(name, fallback string) string {
		if s, ok := os.LookupEnv(name); ok {
			return s
		}
		return fallback
	}
	base := filepath.Join(home, ".config")
	switch runtime.GOOS {
	case "darwin":
		base = filepath.Join(home, "Library", "Application Support")
	case "windows":
		base = env("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	default:
		base = env("XDG_CONFIG_HOME", base)
	}
	return Sources{ClaudeDir: env("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude")), DesktopRoots: []string{filepath.Join(base, "Claude-3p", "claude-code-sessions"), filepath.Join(base, "Claude", "claude-code-sessions")}, CodexHome: env("CODEX_HOME", filepath.Join(home, ".codex")), OpenCodeData: filepath.Join(env("XDG_DATA_HOME", filepath.Join(home, ".local", "share")), "opencode")}
}

// DiscoverSources reads structured metadata and standalone pr-link records. Message text is never subscription evidence.
// IncludeTranscripts=false supports notification enrollment without recovering unverified Desktop aliases.
func DiscoverSources(ctx context.Context, opts DiscoveryOptions) (DiscoveryResult, error) {
	d := &discoverer{transcripts: map[string]transcriptEntry{}}
	return d.discover(ctx, opts)
}
func (d *discoverer) discover(ctx context.Context, opts DiscoveryOptions) (DiscoveryResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.transcripts == nil {
		d.transcripts = map[string]transcriptEntry{}
	}
	sources := DefaultSources(opts.Home)
	if opts.Sources != nil {
		sources = *opts.Sources
	}
	include := opts.IncludeTranscripts == nil || *opts.IncludeTranscripts
	result := DiscoveryResult{Sessions: []ConversationSession{}, Warnings: []string{}}
	readable := true
	incomplete := func() {
		if readable {
			result.Warnings = append(result.Warnings, "Claude Desktop session metadata is incomplete; some identities could not be verified")
		}
		readable = false
	}
	desktop, e := desktopSessions(ctx, sources.DesktopRoots, incomplete)
	if e != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		readable = false
		result.Warnings = append(result.Warnings, "Claude Desktop session metadata could not be read: "+safeError(e))
		desktop = nil
	}
	aliases := map[string]*desktopEntry{}
	for _, entry := range desktop {
		for _, id := range entry.cliIDs {
			aliases[id] = entry
		}
	}
	var claude []ConversationSession
	if sources.ClaudeDir != "" && (include || readable) {
		claude, e = d.claudeSessions(ctx, sources.ClaudeDir, aliases, include)
		if e != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			result.Warnings = append(result.Warnings, "Claude Code session metadata could not be read: "+safeError(e))
			claude = nil
		}
	}
	codex, e := codexSessions(ctx, sources.CodexHome)
	if e != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		result.Warnings = append(result.Warnings, "Codex session metadata could not be read: "+safeError(e))
		codex = nil
	}
	opencode, e := opencodeSessions(ctx, sources.OpenCodeData)
	if e != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		result.Warnings = append(result.Warnings, "OpenCode session metadata could not be read: "+safeError(e))
		opencode = nil
	}
	for _, entry := range desktop {
		result.Sessions = append(result.Sessions, entry.session)
	}
	result.Sessions = append(result.Sessions, claude...)
	result.Sessions = append(result.Sessions, codex...)
	result.Sessions = append(result.Sessions, opencode...)
	seen := map[string]int{}
	out := []ConversationSession{}
	for _, s := range result.Sessions {
		k := s.Adapter + ":" + s.ID
		if i, ok := seen[k]; ok {
			out[i] = s
		} else {
			seen[k] = len(out)
			out = append(out, s)
		}
	}
	result.Sessions = out
	return result, ctx.Err()
}
func isAbsent(e error) bool { return errors.Is(e, os.ErrNotExist) || errors.Is(e, syscall.ENOTDIR) }
func readEntries(directory string, incomplete func()) ([]os.DirEntry, error) {
	if incomplete != nil {
		current := directory
		for {
			st, e := os.Stat(current)
			if e == nil {
				if !st.IsDir() {
					incomplete()
					return nil, nil
				}
				if current != directory {
					return nil, nil
				}
				break
			}
			if !isAbsent(e) {
				return nil, e
			}
			parent := filepath.Dir(current)
			if parent == current {
				incomplete()
				return nil, nil
			}
			current = parent
		}
	}
	files, e := os.ReadDir(directory)
	if isAbsent(e) {
		if incomplete != nil {
			incomplete()
		}
		return []os.DirEntry{}, nil
	}
	return files, e
}
func metadata(path string) (map[string]any, time.Time, error) {
	st, e := os.Stat(path)
	if e != nil {
		if isAbsent(e) {
			return nil, time.Time{}, nil
		}
		return nil, time.Time{}, e
	}
	if st.Size() > 1024*1024 {
		return nil, st.ModTime(), nil
	}
	b, e := readBounded(path, 1024*1024)
	if e != nil {
		if isAbsent(e) {
			return nil, time.Time{}, nil
		}
		return nil, time.Time{}, e
	}
	var value map[string]any
	if json.Unmarshal(b, &value) != nil {
		return nil, st.ModTime(), nil
	}
	return value, st.ModTime(), nil
}
func text(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func truthy(v any) bool {
	switch value := v.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value != ""
	case float64:
		return value != 0
	default:
		return true
	}
}
func object(v any) map[string]any { r, _ := v.(map[string]any); return r }
func array(v any) []any           { r, _ := v.([]any); return r }

var windowsAbsolute = regexp.MustCompile(`^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)`)

func absolute(v any) string {
	s := text(v)
	if strings.HasPrefix(s, "/") || windowsAbsolute.MatchString(s) {
		return s
	}
	return ""
}
func optionalBool(v any) *bool {
	if b, ok := v.(bool); ok {
		return &b
	}
	return nil
}
func boolptr(b bool) *bool { return &b }
func dateISO(t time.Time) string {
	if t.UnixMilli() <= 0 {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func epoch(v any) string {
	var n float64
	switch x := v.(type) {
	case float64:
		n = x
	case int64:
		n = float64(x)
	case int:
		n = float64(x)
	default:
		return ""
	}
	if n < 1e12 {
		n *= 1000
	}
	if n <= 0 || n > 8.64e15 {
		return ""
	}
	return dateISO(time.UnixMilli(int64(n)))
}
func linkedPull(value any) (PullReference, bool) {
	entry := object(value)
	if entry == nil {
		return PullReference{}, false
	}
	if h := entry["host"]; truthy(h) && h != "github.com" {
		return PullReference{}, false
	}
	if p := entry["provider"]; truthy(p) && p != "github" {
		return PullReference{}, false
	}
	u := entry["url"]
	if u == nil {
		u = entry["prUrl"]
	}
	if pr, ok := ParseGitHubPull(text(u)); ok {
		return pr, true
	}
	repo := entry["repo"]
	if repo == nil {
		repo = entry["prRepository"]
	}
	n, ok := entry["prNumber"].(float64)
	if ok && n == float64(int64(n)) && n > 0 && n <= 9007199254740991 {
		return ParseGitHubPull(fmt.Sprintf("https://github.com/%s/pull/%d", text(repo), int64(n)))
	}
	return PullReference{}, false
}
func uniquePulls(values []PullReference) []PullReference {
	out := []PullReference{}
	seen := map[string]int{}
	for _, p := range values {
		k := pullKey(p.Repository, p.Number)
		if i, ok := seen[k]; ok {
			out[i] = p
		} else {
			seen[k] = len(out)
			out = append(out, p)
		}
	}
	return out
}

type desktopEntry struct {
	session       ConversationSession
	cliIDs        []string
	authoritative bool
}

var desktopFile = regexp.MustCompile(`^local_[A-Za-z0-9_-]+\.json$`)

func desktopSessions(ctx context.Context, roots []string, incomplete func()) ([]*desktopEntry, error) {
	found := map[string]*desktopEntry{}
	order := []string{}
	for _, root := range roots {
		accounts, e := readEntries(root, incomplete)
		if e != nil {
			return nil, e
		}
		for _, account := range accounts {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if account.Type()&os.ModeSymlink != 0 {
				incomplete()
				continue
			}
			if !account.IsDir() {
				continue
			}
			profiles, e := readEntries(filepath.Join(root, account.Name()), incomplete)
			if e != nil {
				return nil, e
			}
			for _, profile := range profiles {
				if profile.Type()&os.ModeSymlink != 0 {
					incomplete()
					continue
				}
				if !profile.IsDir() {
					continue
				}
				dir := filepath.Join(root, account.Name(), profile.Name())
				files, e := readEntries(dir, incomplete)
				if e != nil {
					return nil, e
				}
				for _, file := range files {
					if ctx.Err() != nil {
						return nil, ctx.Err()
					}
					if !desktopFile.MatchString(file.Name()) {
						continue
					}
					if !file.Type().IsRegular() {
						incomplete()
						continue
					}
					v, modified, e := metadata(filepath.Join(dir, file.Name()))
					if e != nil {
						return nil, e
					}
					id := text(v["sessionId"])
					if v == nil || id != strings.TrimSuffix(file.Name(), ".json") {
						incomplete()
						continue
					}
					dirs := []string{}
					for _, p := range []any{v["cwd"], v["worktreePath"], v["originCwd"]} {
						if p := absolute(p); p != "" {
							dirs = append(dirs, p)
						}
					}
					for _, a := range array(v["gitAnchors"]) {
						if p := absolute(object(a)["gitRoot"]); p != "" {
							dirs = append(dirs, p)
						}
					}
					dirs = uniqueExact(dirs)
					directory := ""
					if len(dirs) > 0 {
						directory = dirs[0]
					}
					title := text(v["title"])
					if title == "" {
						title = text(v["name"])
					}
					if title == "" {
						title = id
					}
					pulls := []PullReference{}
					for _, p := range array(v["prs"]) {
						if p, ok := linkedPull(p); ok {
							pulls = append(pulls, p)
						}
					}
					s := ConversationSession{ID: id, Agent: "claude", Adapter: "claude-desktop", Title: title, Directory: directory, Directories: dirs, Branch: text(v["branch"]), Archived: optionalBool(v["isArchived"]), LastActive: dateISO(modified), Pulls: uniquePulls(pulls)}
					if previous := found[id]; previous != nil && previous.session.LastActive > s.LastActive {
						continue
					}
					ids := []string{}
					if cli, ok := v["cliSessionId"].(string); ok {
						ids = append(ids, cli)
					}
					for _, p := range array(v["priorCliSessionIds"]) {
						if cli, ok := p.(string); ok {
							ids = append(ids, cli)
						}
					}
					_, auth := v["prs"].([]any)
					if found[id] == nil {
						order = append(order, id)
					}
					found[id] = &desktopEntry{s, ids, auth}
					if len(found) >= maxSessions {
						incomplete()
						return desktopValues(order, found), nil
					}
				}
			}
		}
	}
	return desktopValues(order, found), nil
}
func desktopValues(order []string, found map[string]*desktopEntry) []*desktopEntry {
	out := []*desktopEntry{}
	for _, id := range order {
		out = append(out, found[id])
	}
	return out
}
func uniqueExact(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

var cwdPattern = regexp.MustCompile(`"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"`)

func (d *discoverer) transcript(ctx context.Context, file, id string) (transcriptMeta, error) {
	st, e := os.Stat(file)
	if e != nil {
		return transcriptMeta{}, e
	}
	if cached, ok := d.transcripts[file]; ok && cached.size == st.Size() && cached.modified.Equal(st.ModTime()) {
		return cached.meta, nil
	}
	f, e := os.Open(file)
	if e != nil {
		return transcriptMeta{}, e
	}
	defer f.Close()
	head, e := io.ReadAll(io.LimitReader(f, 64*1024))
	if e != nil {
		return transcriptMeta{}, e
	}
	result := transcriptMeta{Pulls: []PullReference{}}
	if m := cwdPattern.FindSubmatch(head); m != nil {
		var cwd string
		if json.Unmarshal(append(append([]byte{'"'}, m[1]...), '"'), &cwd) == nil {
			result.Directory = absolute(cwd)
		}
	}
	for _, line := range strings.Split(string(head), "\n") {
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			continue
		}
		if result.Branch == "" {
			result.Branch = text(v["gitBranch"])
		}
		if v["type"] == "custom-title" {
			result.Title = text(v["customTitle"])
			if result.Title == "" {
				result.Title = text(v["title"])
			}
		}
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		return result, e
	}
	reader := bufio.NewReaderSize(f, 64*1024)
	var line []byte
	for {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		part, prefix, err := reader.ReadLine()
		line = append(line, part...)
		if !prefix {
			if strings.Contains(string(line), "pr-link") {
				var v map[string]any
				if json.Unmarshal(line, &v) == nil && v["type"] == "pr-link" && (!truthy(v["sessionId"]) || v["sessionId"] == id) {
					if p, ok := linkedPull(v); ok {
						result.Pulls = append(result.Pulls, p)
					}
				}
			}
			line = nil

		}
		if err != nil {
			if err != io.EOF {
				return result, err
			}
			break
		}
	}
	result.Pulls = uniquePulls(result.Pulls)
	d.transcripts[file] = transcriptEntry{st.Size(), st.ModTime(), result}
	if len(d.transcripts) > maxSessions {
		for k := range d.transcripts {
			delete(d.transcripts, k)
			break
		}
	}
	return result, nil
}
func (d *discoverer) claudeSessions(ctx context.Context, root string, desktop map[string]*desktopEntry, include bool) ([]ConversationSession, error) {
	result := []ConversationSession{}
	projects, e := readEntries(filepath.Join(root, "projects"), nil)
	if e != nil {
		return nil, e
	}
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		dir := filepath.Join(root, "projects", project.Name())
		files, e := readEntries(dir, nil)
		if e != nil {
			return nil, e
		}
		fallback := ""
		for _, file := range files {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if !file.Type().IsRegular() || !strings.HasSuffix(file.Name(), ".jsonl") {
				continue
			}
			id := strings.TrimSuffix(file.Name(), ".jsonl")
			if !include && strings.HasPrefix(key(id), "agent-") {
				continue
			}
			mapped := desktop[id]
			if mapped != nil && (mapped.authoritative || !include) {
				continue
			}
			source := filepath.Join(dir, file.Name())
			data := transcriptMeta{Pulls: []PullReference{}}
			if include {
				data, e = d.transcript(ctx, source, id)
				if e != nil {
					return nil, e
				}
			}
			if mapped != nil {
				mapped.session.Pulls = uniquePulls(append(mapped.session.Pulls, data.Pulls...))
				continue
			}
			if include && fallback == "" && data.Directory == "" {
				fallback, _ = DecodeProjectPath(ctx, project.Name(), "")
			}
			directory := data.Directory
			if directory == "" {
				directory = fallback
			}
			dirs := []string{}
			if directory != "" {
				dirs = append(dirs, directory)
			}
			st, e := os.Stat(source)
			if e != nil {
				return nil, e
			}
			title := data.Title
			if title == "" {
				title = id
			}
			result = append(result, ConversationSession{ID: id, Agent: "claude", Adapter: "claude-code", Title: title, Directory: directory, Directories: dirs, Branch: data.Branch, LastActive: dateISO(st.ModTime()), Pulls: data.Pulls})
			if len(result) >= maxSessions {
				return result, nil
			}
		}
	}
	return result, nil
}

var encodeSegment = regexp.MustCompile(`[^a-zA-Z0-9]`)

func DecodeProjectPath(ctx context.Context, name, root string) (string, error) {
	encoded := ""
	if root == "" && runtime.GOOS == "windows" && regexp.MustCompile(`^[A-Za-z]--`).MatchString(name) {
		root = name[:1] + `:\`
		encoded = name[3:]
	} else {
		if !strings.HasPrefix(name, "-") {
			return "", nil
		}
		if root == "" {
			root = string(filepath.Separator)
		}
		encoded = name[1:]
	}
	reads := 0
	var walk func(string, string) (string, error)
	walk = func(directory, rest string) (string, error) {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if rest == "" {
			return directory, nil
		}
		reads++
		if reads > 400 {
			return "", nil
		}
		files, e := readEntries(directory, nil)
		if e != nil {
			return "", nil
		}
		for _, f := range files {
			if !f.IsDir() && f.Type()&os.ModeSymlink == 0 {
				continue
			}
			s := encodeSegment.ReplaceAllString(f.Name(), "-")
			if rest != s && !strings.HasPrefix(rest, s+"-") {
				continue
			}
			next := ""
			if len(rest) > len(s) {
				next = rest[len(s)+1:]
			}
			v, e := walk(filepath.Join(directory, f.Name()), next)
			if e != nil || v != "" {
				return v, e
			}
		}
		return "", nil
	}
	return walk(root, encoded)
}

var databasePattern = regexp.MustCompile(`^state_(\d+)\.sqlite$`)

func latestDatabase(directory string) (string, error) {
	files, e := readEntries(directory, nil)
	if e != nil {
		return "", e
	}
	best := -1
	path := ""
	for _, f := range files {
		if !f.Type().IsRegular() {
			continue
		}
		if m := databasePattern.FindStringSubmatch(f.Name()); m != nil {
			n, _ := strconv.Atoi(m[1])
			if n > best {
				best = n
				path = filepath.Join(directory, f.Name())
			}
		}
	}
	return path, nil
}
func queryRows(ctx context.Context, file, table string, build func(map[string]bool) string) ([]map[string]any, error) {
	u, e := storage.SQLiteReadOnlyURL(file)
	if e != nil {
		return nil, e
	}
	q := u.Query()
	q.Set("mode", "ro")
	q.Add("_pragma", "busy_timeout(1000)")
	u.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", u.String())
	if e != nil {
		return nil, e
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	rows, e := db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if e != nil {
		return nil, e
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var def any
		if e = rows.Scan(&cid, &name, &kind, &notnull, &def, &pk); e != nil {
			rows.Close()
			return nil, e
		}
		columns[name] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	query := build(columns)
	if query == "" {
		return []map[string]any{}, nil
	}
	rows, e = db.QueryContext(ctx, query)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	names, e := rows.Columns()
	if e != nil {
		return nil, e
	}
	out := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(names))
		dest := make([]any, len(names))
		for i := range values {
			dest[i] = &values[i]
		}
		if e = rows.Scan(dest...); e != nil {
			return nil, e
		}
		row := map[string]any{}
		for i, n := range names {
			row[n] = values[i]
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
func codexSessions(ctx context.Context, home string) ([]ConversationSession, error) {
	if home == "" {
		return nil, nil
	}
	file, e := latestDatabase(home)
	if e != nil || file == "" {
		return nil, e
	}
	rows, e := queryRows(ctx, file, "threads", func(c map[string]bool) string {
		if !c["id"] || !c["cwd"] {
			return ""
		}
		sel := func(name, alias string) string {
			if c[name] {
				return name + " AS " + alias
			}
			return "NULL AS " + alias
		}
		return "SELECT id,cwd," + sel("title", "title") + "," + sel("name", "name") + "," + sel("git_branch", "branch") + "," + sel("git_origin_url", "origin") + "," + sel("updated_at", "updated") + "," + sel("archived", "archived") + " FROM threads LIMIT 10000"
	})
	if e != nil {
		return nil, e
	}
	out := []ConversationSession{}
	for _, r := range rows {
		id, ok := r["id"].(string)
		if !ok {
			continue
		}
		title := text(r["name"])
		if title == "" {
			title = text(r["title"])
		}
		if title == "" {
			title = id
		}
		dir := absolute(r["cwd"])
		dirs := []string{}
		if dir != "" {
			dirs = append(dirs, dir)
		}
		var archived *bool
		if n, ok := r["archived"].(int64); ok && (n == 0 || n == 1) {
			archived = boolptr(n == 1)
		}
		out = append(out, ConversationSession{ID: id, Agent: "codex", Adapter: "codex", Title: title, Directory: dir, Directories: dirs, Branch: text(r["branch"]), Origin: text(r["origin"]), Archived: archived, LastActive: epoch(r["updated"]), Pulls: []PullReference{}})
	}
	return out, nil
}
func opencodeSessions(ctx context.Context, data string) ([]ConversationSession, error) {
	if data == "" {
		return nil, nil
	}
	database := filepath.Join(data, "opencode.db")
	if _, e := os.Stat(database); e != nil {
		if isAbsent(e) {
			return opencodeJSONSessions(ctx, filepath.Join(data, "storage", "session"))
		}
		return nil, e
	}
	rows, e := queryRows(ctx, database, "session", func(c map[string]bool) string {
		if !c["id"] || !c["directory"] {
			return ""
		}
		title, updated, archived := "NULL", "NULL", "NULL"
		if c["title"] {
			title = "title"
		}
		if c["time_updated"] {
			updated = "time_updated"
		} else if c["time_created"] {
			updated = "time_created"
		}
		if c["time_archived"] {
			archived = "time_archived"
		}
		return "SELECT id,directory," + title + " AS title," + updated + " AS updated," + archived + " AS archived FROM session LIMIT 10000"
	})
	if e != nil {
		return nil, e
	}
	out := []ConversationSession{}
	for _, r := range rows {
		id, ok := r["id"].(string)
		if !ok {
			continue
		}
		title := text(r["title"])
		if title == "" {
			title = id
		}
		dir := absolute(r["directory"])
		dirs := []string{}
		if dir != "" {
			dirs = append(dirs, dir)
		}
		archived := r["archived"] != nil && r["archived"] != int64(0)
		out = append(out, ConversationSession{ID: id, Agent: "opencode", Adapter: "opencode", Title: title, Directory: dir, Directories: dirs, LastActive: epoch(r["updated"]), Archived: boolptr(archived), Pulls: []PullReference{}})
	}
	return out, nil
}
func opencodeJSONSessions(ctx context.Context, root string) ([]ConversationSession, error) {
	result := []ConversationSession{}
	projects, e := readEntries(root, nil)
	if e != nil {
		return nil, e
	}
	for _, p := range projects {
		if !p.IsDir() {
			continue
		}
		dir := filepath.Join(root, p.Name())
		files, e := readEntries(dir, nil)
		if e != nil {
			return nil, e
		}
		for _, f := range files {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if !f.Type().IsRegular() || !strings.HasSuffix(f.Name(), ".json") {
				continue
			}
			v, _, e := metadata(filepath.Join(dir, f.Name()))
			if e != nil {
				return nil, e
			}
			if v == nil {
				continue
			}
			id := text(v["id"])
			if id == "" {
				id = strings.TrimSuffix(f.Name(), ".json")
			}
			title := text(v["title"])
			if title == "" {
				title = id
			}
			dir := absolute(v["directory"])
			dirs := []string{}
			if dir != "" {
				dirs = append(dirs, dir)
			}
			t := object(v["time"])
			updated := t["updated"]
			if updated == nil {
				updated = t["created"]
			}
			archived := t["archived"] != nil && t["archived"] != float64(0)
			result = append(result, ConversationSession{ID: id, Agent: "opencode", Adapter: "opencode", Title: title, Directory: dir, Directories: dirs, LastActive: epoch(updated), Archived: boolptr(archived), Pulls: []PullReference{}})
			if len(result) >= maxSessions {
				return result, nil
			}
		}
	}
	return result, nil
}

// EligibleThreadSessions applies session-threads.ts's archive/identity rules in recent-first order.
// Enrollment selection and registered cooperative clients remain the caller's responsibility.
func EligibleThreadSessions(sessions []ConversationSession) []ConversationSession {
	out := []ConversationSession{}
	validID := regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	for _, s := range sessions {
		if (s.Archived != nil && *s.Archived) || ((s.Adapter == "claude-desktop" || s.Adapter == "codex") && s.Archived == nil) || !validID.MatchString(s.ID) {
			continue
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastActive > out[j].LastActive })
	return out
}
