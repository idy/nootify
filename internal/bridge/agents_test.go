package bridge

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPromptCreatesMissingAgentDirectoriesAndUsesGoCLI(t *testing.T) {
	s := testService(t)
	for _, agent := range agentIDs {
		entry, err := s.SetAgent(agent, true)
		if err != nil {
			t.Fatalf("enable %s: %v", agent, err)
		}
		if entry.Status != "current" || !entry.Injected {
			t.Fatalf("bad status for %s: %+v", agent, entry)
		}
		if strings.Contains(entry.Block, "cli.js") || strings.Contains(entry.Block, "/node ") {
			t.Fatalf("Node runtime leaked into prompt %s", entry.Block)
		}
		for _, obsolete := range []string{"Tailscale", "tailnet", "port 80", "100.64."} {
			if strings.Contains(entry.Block, obsolete) {
				t.Fatalf("obsolete network instructions in %s prompt: %s", agent, entry.Block)
			}
		}
		for _, required := range []string{"direct LAN access", "listener on the configured port", "does not expose this computer's previews, files, or other ports", "separately configured and verified reachable address", "--state-dir", "--text-file -"} {
			if !strings.Contains(entry.Block, required) {
				t.Fatalf("missing %q in %s prompt: %s", required, agent, entry.Block)
			}
		}
		if !polled(agent) && (!strings.Contains(entry.Block, "`message-ack` and `message-reply` commands carrying their full source reference") || !strings.Contains(entry.Block, "`lark-ack` and `lark-reply`")) {
			t.Fatalf("source callback instructions missing: %s", entry.Block)
		}
		if !strings.Contains(entry.Block, "Nootify executable") || !strings.Contains(entry.Block, "--port 19417") || !strings.Contains(entry.Block, "thread-open") {
			t.Fatalf("missing Go CLI context %s", entry.Block)
		}
		for _, file := range s.promptTargets()[agent] {
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if agent == "trae" && !strings.HasPrefix(string(data), "---\nalwaysApply: true\n---") {
				t.Fatalf("Trae frontmatter missing: %s", data)
			}
		}
		if polled(agent) && (!strings.Contains(entry.Block, "thread-receive") || !strings.Contains(entry.Block, "thread-ack") || !strings.Contains(entry.Block, "returned session_id")) {
			t.Fatalf("polling instructions missing: %s", entry.Block)
		}
	}
}
func TestPromptPreservesSymlinkModeContentAndBackups(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlinks require developer mode")
	}
	s := testService(t)
	file := s.promptTargets()["claude"][0]
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(s.options.Home, "dotfiles", "claude.md")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	original := "# My instructions\nKeep this text exactly.\n"
	if err := os.WriteFile(target, []byte(original), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, file); err != nil {
		t.Fatal(err)
	}
	entry, err := s.SetAgent("claude", true)
	if err != nil || entry.Status != "current" {
		t.Fatalf("inject %v %v", entry, err)
	}
	link, err := os.Readlink(file)
	if err != nil || link != target {
		t.Fatal("injection replaced symlink")
	}
	info, err := os.Stat(target)
	if err != nil || info.Mode().Perm() != 0640 {
		t.Fatalf("mode changed %v %v", info, err)
	}
	backups, err := os.ReadDir(filepath.Join(s.options.Store.Directory, "agent-backups"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("missing backup %v %v", backups, err)
	}
	data, err := os.ReadFile(filepath.Join(s.options.Store.Directory, "agent-backups", backups[0].Name()))
	if err != nil || string(data) != original {
		t.Fatalf("wrong backup %s %v", data, err)
	}
	if _, err = s.SetAgent("claude", true); err != nil {
		t.Fatal(err)
	}
	backups, _ = os.ReadDir(filepath.Join(s.options.Store.Directory, "agent-backups"))
	if len(backups) != 1 {
		t.Fatal("unchanged enable created extra backup")
	}
	if _, err = s.SetAgent("claude", false); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(target)
	if err != nil || string(data) != original {
		t.Fatalf("removal changed content %q %v", data, err)
	}
	if _, err = os.Readlink(file); err != nil {
		t.Fatal("removal replaced symlink")
	}
	for i := 0; i < 14; i++ {
		if _, err = s.SetAgent("claude", true); err != nil {
			t.Fatal(err)
		}
		if _, err = s.SetAgent("claude", false); err != nil {
			t.Fatal(err)
		}
	}
	backups, _ = os.ReadDir(filepath.Join(s.options.Store.Directory, "agent-backups"))
	if len(backups) != 10 {
		t.Fatalf("backup cap %d", len(backups))
	}
	for _, file := range backups {
		info, err := file.Info()
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("backup permissions %v %v", info, err)
		}
	}
}
func TestPromptConflictsAndSharedTargetsAreNeverEdited(t *testing.T) {
	s := testService(t)
	claude := s.promptTargets()["claude"][0]
	if err := os.MkdirAll(filepath.Dir(claude), 0700); err != nil {
		t.Fatal(err)
	}
	broken := "Keep\n" + Begin + "\nmissing end\n"
	if err := os.WriteFile(claude, []byte(broken), 0600); err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{true, false} {
		if _, err := s.SetAgent("claude", enabled); err == nil {
			t.Fatal("edited broken markers")
		}
		data, _ := os.ReadFile(claude)
		if string(data) != broken {
			t.Fatal("conflicting file was changed")
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	if err := os.WriteFile(claude, []byte("Keep\n"), 0600); err != nil {
		t.Fatal(err)
	}
	codex := s.promptTargets()["codex"][0]
	if err := os.MkdirAll(filepath.Dir(codex), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(claude, codex); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetAgent("claude", true); err == nil {
		t.Fatal("enabled agent-specific instructions in shared symlink")
	}
	data, _ := os.ReadFile(claude)
	if string(data) != "Keep\n" {
		t.Fatal("shared target edited")
	}
}
func TestTraePreflightChecksEveryEdition(t *testing.T) {
	s := testService(t)
	files := s.promptTargets()["trae"]
	if err := os.MkdirAll(filepath.Dir(files[1]), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(files[1], []byte(End), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetAgent("trae", true); err == nil {
		t.Fatal("Trae edition with conflict accepted")
	}
	if _, err := os.Stat(files[0]); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("preflight failure partially modified first edition")
	}
}
func TestBrokenPromptSymlinkFailsClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privileges")
	}
	s := testService(t)
	file := s.promptTargets()["codex"][0]
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(s.options.Home, "missing-target"), file); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetAgent("codex", true); err == nil {
		t.Fatal("overwrote dangling symlink")
	}
	if _, err := os.Readlink(file); err != nil {
		t.Fatal("dangling link replaced")
	}
}
func TestPromptMarkerOperationsKeepOtherContent(t *testing.T) {
	for _, original := range []string{"", "text", "text\n", "text\n\n"} {
		added, err := withBlock(original, Begin+"\nblock\n"+End)
		if err != nil {
			t.Fatal(err)
		}
		removed, err := withoutBlock(added)
		if err != nil {
			t.Fatal(err)
		}
		if original != "text" && removed != original {
			t.Fatalf("roundtrip %q -> %q", original, removed)
		}
		if original == "text" && removed != "text\n" {
			t.Fatalf("line separator changed %q", removed)
		}
	}
	for _, content := range []string{End + Begin, Begin + End + Begin, Begin, End} {
		if _, err := withBlock(content, "replacement"); err == nil {
			t.Errorf("accepted malformed markers %s", content)
		}
	}
}
