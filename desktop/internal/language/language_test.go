package language

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPreferencePersistenceAndValidation(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "app", "language.json")
	system := func() Locale { return ZH }
	store := Load(path, system)
	if store.View() != NewView(System, ZH) {
		t.Fatal(store.View())
	}
	for _, p := range []Preference{English, Chinese, System} {
		if _, err := store.Set(p); err != nil {
			t.Fatal(err)
		}
		if got := Load(path, system).View(); got != NewView(p, ZH) {
			t.Fatal(got)
		}
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0600 {
			t.Fatal(info.Mode())
		}
	}
	for _, data := range []string{"{}", "[]", "null", "not JSON", `{"preference":"fr"}`, `{"preference":"en","token":"do not accept"}`, `{"preference":"en"}{}`, strings.Repeat(" ", 1025)} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := read(path); err == nil {
			t.Errorf("accepted %q", data)
		}
		if Load(path, system).View().Preference != System {
			t.Fatal("invalid preference did not fall back")
		}
	}
}
func TestPersistenceFailureDoesNotCommitPreference(t *testing.T) {
	root := t.TempDir()
	blocked := filepath.Join(root, "file")
	if err := os.WriteFile(blocked, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	store := Load(filepath.Join(blocked, "language.json"), func() Locale { return EN })
	if _, err := store.Set(Chinese); err == nil {
		t.Fatal("expected persistence failure")
	}
	if store.View() != NewView(System, EN) {
		t.Fatal(store.View())
	}
}
func TestSystemRefreshIsIndependentAndMemoryOnlySmoke(t *testing.T) {
	current := EN
	store := Load("", func() Locale { return current })
	current = ZH
	if !store.RefreshSystem() || store.View().Locale != ZH {
		t.Fatal("system refresh missing")
	}
	if store.RefreshSystem() {
		t.Fatal("duplicate change")
	}
	if _, err := store.Set(English); err != nil {
		t.Fatal(err)
	}
	if store.RefreshSystem() || store.View().Locale != EN {
		t.Fatal("explicit choice changed")
	}
}
func TestDocumentStartBridgeContract(t *testing.T) {
	for _, v := range []View{NewView(System, EN), NewView(System, ZH), NewView(English, ZH), NewView(Chinese, EN)} {
		seed := v.SeedScript()
		if !strings.Contains(seed, "window.mygo?.locale") || !strings.Contains(seed, "window.__NOOTIFY_LANGUAGE__") || !strings.Contains(seed, v.BridgeTag()) {
			t.Fatal(seed)
		}
		if strings.Contains(seed, "localStorage") || strings.Contains(seed, "sessionStorage") {
			t.Fatal("browser persistence in language seed")
		}
		if !strings.Contains(v.Script(), "nootify-language") {
			t.Fatal(v.Script())
		}
	}
}
func TestCapturedSeedUsesRegeneratedBridgeLocaleAfterPreferenceChanges(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required for the headless document-start JavaScript regression")
	}
	// Capture the preload once, as MyGo WindowOptions does. Each fresh synthetic
	// document receives MyGo's current bridge locale before that same old preload.
	seed := NewView(English, EN).SeedScript()
	for _, view := range []View{NewView(Chinese, EN), NewView(System, ZH), NewView(System, EN), NewView(English, ZH)} {
		want, _ := json.Marshal(view)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, node, "-e", `const vm=require('node:vm');const page={window:{mygo:{locale:process.argv[2]}}};vm.runInNewContext(process.argv[1],page);process.stdout.write(JSON.stringify(page.window.__NOOTIFY_LANGUAGE__));`, seed, view.BridgeTag()).CombinedOutput()
		cancel()
		if err != nil || string(out) != string(want) {
			t.Fatalf("captured seed with %s: %s, %v", view.BridgeTag(), out, err)
		}
	}
}

func TestResolveAndLiteralInterpolation(t *testing.T) {
	for _, s := range []string{"zh", "ZH-sg", "zh-Hant-TW", "zh_HK"} {
		if Resolve(s) != ZH {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"", "fr-FR", "ja-JP", "en"} {
		if Resolve(s) != EN {
			t.Fatal(s)
		}
	}
	got := EN.Format(ActionFailed, map[string]string{"action": "Start", "error": "{action}: 路径"})
	if got != "Start failed: {action}: 路径" {
		t.Fatal(got)
	}
}
