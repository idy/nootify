package host

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"
	"time"
)

const headlessWorkspaceEnv = "NOOTIFY_HEADLESS_WORKSPACE"
const headlessStateDirEnv = "NOOTIFY_HEADLESS_STATE_DIR"

func headlessDescendant(workspace, directory string) bool {
	relative, err := filepath.Rel(workspace, directory)
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// TestHeadlessServiceProcess is a test-binary-only HTTP host, never a production
// entrypoint. Both explicit paths are checked before New or any filesystem write.
func TestHeadlessServiceProcess(t *testing.T) {
	workspace, workspaceSet := os.LookupEnv(headlessWorkspaceEnv)
	stateDir, stateSet := os.LookupEnv(headlessStateDirEnv)
	if !workspaceSet && !stateSet {
		t.Skip("headless service requires an explicit isolated workspace and state directory")
	}
	if !workspaceSet || !stateSet || !filepath.IsAbs(workspace) || !filepath.IsAbs(stateDir) || !headlessDescendant(workspace, stateDir) {
		t.Fatal("headless service refuses state outside its private workspace")
	}
	// Canonical checks also reject a lexically contained path that escapes through
	// a symlink. The runner creates these directories before launching the fixture.
	realWorkspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal("headless service requires an existing private workspace")
	}
	realState, err := filepath.EvalSymlinks(stateDir)
	if err != nil || !headlessDescendant(realWorkspace, realState) {
		t.Fatal("headless service refuses state outside its private workspace")
	}
	for _, directory := range []string{realWorkspace, realState} {
		info, err := os.Stat(directory)
		if err != nil || !info.IsDir() {
			t.Fatal("headless service requires real workspace and state directories")
		}
	}
	home := filepath.Join(realState, "home")
	// The normal host runs unchanged, but all ambient configuration roots and
	// credentials are replaced with synthetic, per-service paths after the guard.
	for name, value := range map[string]string{
		"HOME": home, "USERPROFILE": home,
		"APPDATA":           filepath.Join(home, "AppData", "Roaming"),
		"LOCALAPPDATA":      filepath.Join(home, "AppData", "Local"),
		"CLAUDE_CONFIG_DIR": filepath.Join(home, ".claude"),
		"CODEX_HOME":        filepath.Join(home, ".codex"),
		"XDG_CONFIG_HOME":   filepath.Join(home, ".config"),
		"XDG_DATA_HOME":     filepath.Join(home, ".local", "share"),
		"LARK_APP_ID":       "", "LARK_APP_SECRET": "", "LARK_NOTIFY_OPEN_ID": "",
		"NOOTIFY_PULLS_CONFIG": "", "NOOTIFY_TAILNET_USERS": "", "OPENCODE_SERVER_URL": "",
	} {
		t.Setenv(name, value)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server, err := New(ctx, Options{
		StateDir: realState, Home: home, Port: 0, Version: "headless-integration",
		Executable: os.Getenv("NOOTIFY_INTEGRATION_CLI_BIN"),
		Assets:     fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>Headless integration</title>")}},
		Output:     io.Discard,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := server.Close(); err != nil {
			t.Error(err)
		}
	}()
	readyCtx, stopReady := context.WithTimeout(ctx, 5*time.Second)
	page, err := server.providers.Page(readyCtx)
	stopReady()
	if err != nil {
		t.Fatal("headless provider status failed:", err)
	}
	nodeID, ok := page["node_id"].(string)
	if !ok || nodeID == "" {
		t.Fatal("headless provider status omitted node identity")
	}
	if err = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"kind": "service-ready", "headless": true, "node_id": nodeID,
		"url": server.URL(), "port": server.options.Port, "token": server.store.Token,
	}); err != nil {
		t.Fatal("cannot announce headless service readiness")
	}
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	if err = server.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	// Wait joins Close, including directly imported core streams and storage.
}
