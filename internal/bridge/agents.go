package bridge

import (
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
	"time"
)

const Begin = "<!-- nootify:begin -->"
const End = "<!-- nootify:end -->"

var agentIDs = []string{"claude", "codex", "opencode", "trae", "workbuddy"}
var agentNames = map[string]string{"claude": "Claude Code", "codex": "Codex", "opencode": "OpenCode", "trae": "Trae", "workbuddy": "WorkBuddy"}

type AgentPrompt struct {
	Agent    string   `json:"agent"`
	Name     string   `json:"name"`
	File     string   `json:"file"`
	Files    []string `json:"files,omitempty"`
	Status   string   `json:"status"`
	Injected bool     `json:"injected"`
	Block    string   `json:"block"`
	Error    string   `json:"error,omitempty"`
}

func (s *Service) promptTargets() map[string][]string {
	h := s.options.Home
	result := map[string][]string{
		"claude":    {filepath.Join(envPath("CLAUDE_CONFIG_DIR", filepath.Join(h, ".claude")), "CLAUDE.md")},
		"codex":     {filepath.Join(envPath("CODEX_HOME", filepath.Join(h, ".codex")), "AGENTS.md")},
		"opencode":  {filepath.Join(envPath("XDG_CONFIG_HOME", filepath.Join(h, ".config")), "opencode", "AGENTS.md")},
		"trae":      {envPath("NOOTIFY_TRAE_RULES_FILE", filepath.Join(h, ".trae", "user_rules", "nootify.md"))},
		"workbuddy": {envPath("NOOTIFY_WORKBUDDY_RULES_FILE", filepath.Join(h, ".codebuddy", "CODEBUDDY.md"))},
	}
	if os.Getenv("NOOTIFY_TRAE_RULES_FILE") == "" {
		result["trae"] = append(result["trae"], filepath.Join(h, ".trae-cn", "user_rules", "nootify.md"))
	}
	return result
}

var compactShell = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)

func powerShell(agent string) bool {
	return runtime.GOOS == "windows" && agent != "claude" && agent != "claude-code" && agent != "claude-desktop"
}
func shellQuote(value, agent string, compact bool) string {
	if powerShell(agent) {
		var out strings.Builder
		out.WriteByte('\'')
		for _, r := range value {
			out.WriteRune(r)
			if r == '\'' || r >= '‘' && r <= '‛' {
				out.WriteRune(r)
			}
		}
		out.WriteByte('\'')
		return out.String()
	}
	if compact && compactShell.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
func shellCommand(executable, agent string, compact bool) string {
	prefix := ""
	if powerShell(agent) {
		prefix = "& "
	} else if runtime.GOOS == "windows" {
		prefix = "MSYS2_ARG_CONV_EXCL='*' "
		executable = strings.ReplaceAll(executable, "\\", "/")
		if strings.HasPrefix(strings.ToLower(executable), "//?/unc/") {
			executable = "//" + executable[8:]
		} else {
			executable = strings.TrimPrefix(executable, "//?/")
		}
	}
	return prefix + shellQuote(executable, agent, compact)
}
func (s *Service) promptBlock(agent string) string {
	base := shellCommand(s.options.Executable, agent, true)
	extra := " --state-dir " + shellQuote(s.options.Store.Directory, agent, true)
	if s.options.Port != 9417 {
		extra += " --port " + strconv.Itoa(s.options.Port)
	}
	identity := "--agent " + agent
	if agent == "opencode" {
		identity += " --session-id <this ses_… session ID>"
	}
	run := func(command, args string) string {
		suffix := identity
		if polled(agent) && command != "thread-open" {
			suffix += " --session-id \"<returned session_id>\""
		}
		if args != "" {
			suffix += " " + args
		}
		return "`" + base + " " + command + " " + suffix + extra + "`"
	}
	lines := []string{Begin, "## Session updates through Nootify", "", "Nootify connects each conversation to the configured notification provider, directly or through another Nootify. The user can follow progress and reply from there.", "", "- For work longer than a quick answer, open this conversation's notification session first. Later calls reuse its provider binding:", "  " + run("thread-open", "--session-name \"<short task title>\"")}
	if polled(agent) {
		lines = append(lines, "- Run thread-open once per conversation. Keep the returned session_id in this conversation and replace \"<returned session_id>\" in all subsequent commands with it. Reuse it with --session-id when retrying thread-open; do not reuse another conversation's ID or derive it from a project directory.")
	}
	lines = append(lines, "- Post progress, blockers and results as you go, in the user's language. Each message is prefixed with the session name:", "  "+run("thread-send", "--text \"<message>\""), "  Use `--text-file -` to send multi-line text from standard input.", "- Nootify provides direct LAN access only through its listener on the configured port. This listener serves only Nootify; it does not expose this computer's previews, files, or other ports. Share other local pages or files only through a separately configured and verified reachable address.")
	if polled(agent) {
		lines = append(lines, "- At work milestones, before asking the user a question, and before finishing, check this conversation's inbox:", "  "+run("thread-receive", ""), "- Read each returned message.text as user input. Follow its original-channel receipt and reply commands, then acknowledge that inbox item using its returned message.id:", "  "+run("thread-ack", "--message-id \"<returned message.id>\""), "- Inbox reads are repeatable until acknowledged. Polling cannot wake an idle or closed conversation; do not busy-poll or claim that queued messages have already been read.")
	} else {
		lines = append(lines, "- Messages arrive marked 【来自 Nootify 用户的消息】 with `message-ack` and `message-reply` commands carrying their full source reference. Older messages may use 【来自飞书用户的消息】 with `lark-ack` and `lark-reply`. Follow the commands attached to each message and answer when convenient.")
	}
	lines = append(lines, "- Nootify maintains this block; change it on Nootify's Agents page instead of editing it here.", End)
	return strings.Join(lines, "\n")
}
func locate(content string) (start, end int, err error) {
	begins, ends := strings.Count(content, Begin), strings.Count(content, End)
	if begins == 0 && ends == 0 {
		return -1, -1, nil
	}
	start = strings.Index(content, Begin)
	end = strings.Index(content, End)
	if begins != 1 || ends != 1 || end < start {
		return 0, 0, httpError(409, "The prompt file has unbalanced Nootify markers; fix them by hand first")
	}
	return start, end + len(End), nil
}
func withBlock(content, block string) (string, error) {
	start, end, err := locate(content)
	if err != nil {
		return "", err
	}
	if start >= 0 {
		return content[:start] + block + content[end:], nil
	}
	separator := ""
	if content != "" {
		if strings.HasSuffix(content, "\n") {
			separator = "\n"
		} else {
			separator = "\n\n"
		}
	}
	return content + separator + block + "\n", nil
}
func withoutBlock(content string) (string, error) {
	start, end, err := locate(content)
	if err != nil {
		return "", err
	}
	if start < 0 {
		return content, nil
	}
	before, after := content[:start], content[end:]
	after = strings.TrimPrefix(after, "\n")
	if strings.HasSuffix(before, "\n\n") {
		before = before[:len(before)-1]
	}
	return before + after, nil
}
func promptTarget(file string) (string, error) {
	target, err := filepath.EvalSymlinks(file)
	if err == nil {
		return target, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if info, e := os.Lstat(file); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", httpError(409, file+" is a symlink to a missing file")
	}
	parent, e := filepath.EvalSymlinks(filepath.Dir(file))
	if e == nil {
		return filepath.Join(parent, filepath.Base(file)), nil
	}
	if !errors.Is(e, os.ErrNotExist) {
		return "", e
	}
	return filepath.Abs(file)
}
func readPrompt(file string) (string, bool, error) {
	if info, err := os.Stat(file); err == nil && !info.Mode().IsRegular() {
		return "", false, fmt.Errorf("Prompt target is not a regular file")
	}
	f, err := os.Open(file)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() {
		return "", false, fmt.Errorf("Prompt target is not a regular file")
	}
	if info.Size() > 1024*1024 {
		return "", false, httpError(413, file+" exceeds 1 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(f, 1024*1024+1))
	if len(data) > 1024*1024 {
		return "", false, httpError(413, file+" exceeds 1 MiB")
	}
	return string(data), true, err
}
func (s *Service) inspectPrompt(agent, file string) AgentPrompt {
	entry := AgentPrompt{Agent: agent, Name: agentNames[agent], File: file, Status: "absent", Block: s.promptBlock(agent)}
	info, err := os.Stat(filepath.Dir(file))
	if errors.Is(err, os.ErrNotExist) {
		entry.Status = "missing"
		return entry
	}
	if err != nil || !info.IsDir() {
		entry.Status = "error"
		entry.Error = "Prompt directory is unavailable"
		return entry
	}
	target, err := promptTarget(file)
	if err != nil {
		entry.Status = "error"
		entry.Error = err.Error()
		return entry
	}
	content, _, err := readPrompt(target)
	if err != nil {
		entry.Status = "error"
		entry.Error = err.Error()
		return entry
	}
	start, end, err := locate(content)
	if err != nil {
		entry.Status = "conflict"
		return entry
	}
	if start < 0 {
		return entry
	}
	entry.Injected = true
	entry.Status = "outdated"
	if content[start:end] == entry.Block {
		entry.Status = "current"
	}
	return entry
}
func (s *Service) inspectAgent(agent string) AgentPrompt {
	files := s.promptTargets()[agent]
	entry := s.inspectPrompt(agent, files[0])
	allCurrent, allMissing, injected := true, true, false
	failureStatus, failureError := "", ""
	for _, file := range files {
		e := s.inspectPrompt(agent, file)
		allCurrent = allCurrent && e.Status == "current"
		allMissing = allMissing && e.Status == "missing"
		injected = injected || e.Injected
		if failureStatus == "" && (e.Status == "conflict" || e.Status == "error") {
			failureStatus = e.Status
			if e.Error != "" {
				failureError = e.File + ": " + e.Error
			}
		}
	}
	entry.Injected = injected
	entry.Error = failureError
	switch {
	case failureStatus != "":
		entry.Status = failureStatus
	case allCurrent:
		entry.Status = "current"
	case injected:
		entry.Status = "outdated"
	case allMissing:
		entry.Status = "missing"
	default:
		entry.Status = "absent"
	}
	if len(files) > 1 {
		entry.Files = files
	}
	return entry
}
func (s *Service) Agents() ([]AgentPrompt, error) {
	s.promptMu.Lock()
	defer s.promptMu.Unlock()
	result := make([]AgentPrompt, 0, len(agentIDs))
	for _, id := range agentIDs {
		result = append(result, s.inspectAgent(id))
	}
	return result, nil
}
func (s *Service) SetAgent(agent string, enabled bool) (AgentPrompt, error) {
	if agentNames[agent] == "" {
		return AgentPrompt{}, httpError(404, "Unknown agent")
	}
	s.promptMu.Lock()
	defer s.promptMu.Unlock()
	targets := s.promptTargets()
	entries := []AgentPrompt{}
	// Preflight every edition and every other agent before editing any target.
	for _, file := range targets[agent] {
		entry := s.inspectPrompt(agent, file)
		if entry.Status == "conflict" || entry.Status == "error" {
			return AgentPrompt{}, httpError(409, "Cannot edit "+file+": "+entry.Status+" "+entry.Error)
		}
		path, err := promptTarget(file)
		if err != nil {
			return AgentPrompt{}, err
		}
		if enabled {
			for other, files := range targets {
				if other == agent {
					continue
				}
				for _, file := range files {
					otherPath, err := promptTarget(file)
					if err == nil && otherPath == path {
						return AgentPrompt{}, httpError(409, agentNames[agent]+" and "+agentNames[other]+" share the same prompt file; separate their files before adding agent-specific instructions")
					}
				}
			}
		}
		entries = append(entries, entry)
	}
	for _, entry := range entries {
		if err := s.applyPrompt(entry, enabled); err != nil {
			return AgentPrompt{}, err
		}
	}
	return s.inspectAgent(agent), nil
}
func (s *Service) applyPrompt(entry AgentPrompt, enabled bool) error {
	if entry.Status == "missing" {
		if !enabled {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(entry.File), 0700); err != nil {
			return err
		}
	}
	target, err := promptTarget(entry.File)
	if err != nil {
		return err
	}
	before, exists, err := readPrompt(target)
	if err != nil {
		return err
	}
	var after string
	if enabled {
		after, err = withBlock(before, entry.Block)
		if entry.Agent == "trae" && !exists {
			after = "---\nalwaysApply: true\n---\n\n" + after
		}
	} else {
		after, err = withoutBlock(before)
	}
	if err != nil {
		return err
	}
	if after == before && (exists || !enabled) {
		return nil
	}
	if exists {
		if err := s.backupPrompt(entry.Agent, before); err != nil {
			return err
		}
	}
	if after == "" && exists {
		err = os.Remove(target)
	} else {
		mode := os.FileMode(0644)
		if exists {
			info, e := os.Stat(target)
			if e != nil {
				return e
			}
			mode = info.Mode().Perm()
		}
		err = atomicPrompt(target, after, mode)
	}
	if err != nil {
		return err
	}
	status := "prompt_removed"
	if enabled {
		status = "prompt_injected"
	}
	s.options.Report(map[string]any{"source": "agents", "status": status, "reason": entry.Name + ": " + entry.File})
	return nil
}
func atomicPrompt(target, content string, mode os.FileMode) error {
	temporary := filepath.Join(filepath.Dir(target), "."+newID()+".nootify.tmp")
	f, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	if err = f.Chmod(mode); err == nil {
		_, err = f.WriteString(content)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temporary, target)
}
func (s *Service) backupPrompt(agent, content string) error {
	directory := filepath.Join(s.options.Store.Directory, "agent-backups")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return err
	}
	name := agent + "-" + time.Now().UTC().Format("2006-01-02T15-04-05.000000000") + "-" + newID()[:8] + ".md"
	f, err := os.OpenFile(filepath.Join(directory, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.WriteString(content)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	files, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	names := []string{}
	for _, file := range files {
		if strings.HasPrefix(file.Name(), agent+"-") {
			names = append(names, file.Name())
		}
	}
	sort.Strings(names)
	for len(names) > 10 {
		if err := os.Remove(filepath.Join(directory, names[0])); err != nil {
			return err
		}
		names = names[1:]
	}
	return nil
}
