package service

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestHealthContractAndLimit(t *testing.T) {
	for _, data := range []string{`{"service":"nootify","modules":[]}`, `{"ok":true,"service":"nootify","modules":[{"name":"lark","status":"disabled"}]}`} {
		if _, err := ParseHealth([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	for _, data := range []string{`{"service":"other","modules":[]}`, `{"service":"nootify"}`, `{"service":"nootify","modules":[{"name":"lark"}]}`, strings.Repeat(" ", outputLimit+1)} {
		if _, err := ParseHealth([]byte(data)); err == nil {
			t.Errorf("accepted %q", data)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "http://127.0.0.1:1/", 302) }))
	defer server.Close()
	if _, err := CheckHealth(context.Background(), HealthClient(), server.URL); err == nil || !strings.Contains(err.Error(), "HTTP 302") {
		t.Fatalf("followed health redirect: %v", err)
	}
}
func TestBundleLayout(t *testing.T) {
	b := Locate(filepath.FromSlash("/Applications/Nootify.app/Contents/MacOS/Nootify"), "darwin")
	if b == nil || b.CLI != filepath.FromSlash("/Applications/Nootify.app/Contents/Resources/service/dist/src/cli.js") {
		t.Fatal(b)
	}
	for _, exe := range []string{"/repo/desktop/nootify", "/Applications/Nootify/Contents/MacOS/Nootify", "/repo/target/Contents/MacOS/Nootify"} {
		if Locate(filepath.FromSlash(exe), "darwin") != nil {
			t.Fatal(exe)
		}
	}
	root := t.TempDir()
	w := Locate(filepath.Join(root, "Nootify.exe"), "windows")
	if w.Node != filepath.Join(root, "node.exe") || w.CLI != filepath.Join(root, "service", "dist", "src", "cli.js") {
		t.Fatal(w)
	}
}
func TestManagementEnvironmentIsAnAllowlist(t *testing.T) {
	ambient := []string{"NODE_OPTIONS=--require /evil", "LARK_APP_SECRET=private", "SLACK_BOT_TOKEN=private", "TS_AUTHKEY=private", "NOOTIFY_CORE_BIN=/evil", "MYGO_GENERATE=/evil", "PATH=/shell/path", "HOME=/wrong", "USER=example", "SystemRoot=C:\\Windows", "USERPROFILE=C:\\Users\\example", "TMPDIR=/tmp/example"}
	for _, platform := range []string{"darwin", "windows"} {
		env := cleanEnvironment(platform, "/safe/home", ambient)
		for _, entry := range env {
			if strings.Contains(entry, "private") || strings.Contains(entry, "/evil") || entry == "HOME=/wrong" {
				t.Fatalf("leaked environment: %q", entry)
			}
		}
		if !slices.Contains(env, "HOME=/safe/home") {
			t.Fatal(env)
		}
		if platform == "darwin" && slices.Contains(env, "PATH=/shell/path") {
			t.Fatal(env)
		}
		if platform == "windows" && !slices.Contains(env, "SystemRoot=C:\\Windows") {
			t.Fatal(env)
		}
	}
}
func TestPlistNeverRewrittenAndOccupiedPortRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink fixture needs no Windows privileges")
	}
	home := t.TempDir()
	m := New(home, &Bundled{"/nonexistent/node", "/nonexistent/cli.js"})
	m.platform = "darwin"
	called := false
	m.run = func(context.Context, Command) Output { called = true; return Output{} }
	if err := os.MkdirAll(filepath.Dir(m.plist()), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/nonexistent", m.plist()); err != nil {
		t.Fatal(err)
	}
	installed, err := m.Installed(context.Background())
	if err != nil || !installed {
		t.Fatal(installed, err)
	}
	if err := m.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "never rewritten") {
		t.Fatal(err)
	}
	if called {
		t.Fatal("existing plist passed to installer")
	}
	if err := os.Remove(m.plist()); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	m.address = listener.Addr().String()
	if err := m.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatal(err)
	}
	if called {
		t.Fatal("occupied port reached installer")
	}
}
func TestCLIReceivesOnlyOwnedPathsAndCheckedActions(t *testing.T) {
	home := t.TempDir()
	m := New(home, &Bundled{filepath.Join(home, "node"), filepath.Join(home, "service", "cli.js")})
	m.platform = "windows"
	config := filepath.Join(home, ".claude.json")
	if err := os.WriteFile(config, []byte("not read"), 0600); err != nil {
		t.Fatal(err)
	}
	var calls []Command
	m.run = func(_ context.Context, c Command) Output {
		calls = append(calls, c)
		return Output{Stdout: `{"installed":true}`}
	}
	if err := m.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || !slices.Equal(calls[0].Args, []string{m.Bundle.CLI, "service-install", "--mcp-config", config}) || calls[0].Dir != home || calls[0].Timeout != 155*time.Second {
		t.Fatal(calls)
	}
	for _, action := range []string{"start", "restart", "stop"} {
		if err := m.Request(context.Background(), action); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(calls[len(calls)-1].Args, []string{m.Bundle.CLI, "service-" + action}) {
			t.Fatal(calls)
		}
	}
	before := len(calls)
	if err := m.Request(context.Background(), "uninstall"); err == nil || len(calls) != before {
		t.Fatal("arbitrary CLI action accepted")
	}
	m.run = func(context.Context, Command) Output {
		return Output{Err: errors.New("exit 1"), Stderr: "warning\n{\"error\":\"Refusing to control another installation\"}\n"}
	}
	if err := m.Request(context.Background(), "restart"); err == nil || err.Error() != "Refusing to control another installation" {
		t.Fatal(err)
	}
}
func TestStopForUpdateRetainsCLIRegistrationChecks(t *testing.T) {
	for _, scenario := range []string{"absent", "owned", "foreign", "stop failed"} {
		t.Run(scenario, func(t *testing.T) {
			home := t.TempDir()
			m := New(home, &Bundled{filepath.Join(home, "node"), filepath.Join(home, "cli.js")})
			m.platform = "darwin"
			if scenario != "absent" {
				if err := os.MkdirAll(filepath.Dir(m.plist()), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(m.plist(), []byte("private fake registration; never parsed by launchctl"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var calls []Command
			refused := errors.New("stop failed")
			m.run = func(_ context.Context, c Command) Output {
				calls = append(calls, c)
				if scenario == "foreign" {
					return Output{Err: refused, Stderr: `{"error":"Refusing to control another installation"}`}
				}
				if scenario == "stop failed" {
					return Output{Err: refused}
				}
				return Output{}
			}
			stopped, err := m.StopForUpdate(context.Background())
			if stopped != (scenario == "owned") || (err != nil) != (scenario == "foreign" || scenario == "stop failed") {
				t.Fatal(stopped, err)
			}
			if scenario == "absent" {
				if len(calls) != 0 {
					t.Fatal("missing registration reached a service command", calls)
				}
			} else if len(calls) != 1 || calls[0].Path != m.Bundle.Node || !slices.Equal(calls[0].Args, []string{m.Bundle.CLI, "service-stop"}) || calls[0].Dir != home {
				t.Fatal("stop bypassed the exact installation CLI", calls)
			}
			if scenario == "foreign" && err.Error() != "Refusing to control another installation" {
				t.Fatal("ownership refusal was hidden", err)
			}
		})
	}
}

func TestCommandDrainsOutputAndBoundsDuration(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The helper is this test binary, keeping identical argv/pipe behavior on Windows.
	c := Command{Path: exe, Args: []string{"-test.run=TestCommandHelper"}, Env: append(os.Environ(), "NOOTIFY_TEST_CHILD=output"), Timeout: 5 * time.Second}
	out := Run(context.Background(), c)
	if out.Err != nil || len(out.Stdout) != outputLimit || len(out.Stderr) != outputLimit {
		t.Fatalf("bounded drain: %d %d %v", len(out.Stdout), len(out.Stderr), out.Err)
	}
	c.Env = append(os.Environ(), "NOOTIFY_TEST_CHILD=wait")
	c.Timeout = 100 * time.Millisecond
	start := time.Now()
	out = Run(context.Background(), c)
	if out.Err == nil || time.Since(start) > 4*time.Second {
		t.Fatalf("timeout failed: %v", out.Err)
	}
}
func TestCommandHelper(t *testing.T) {
	switch os.Getenv("NOOTIFY_TEST_CHILD") {
	case "output":
		data := []byte(strings.Repeat("x", 512*1024))
		_, _ = os.Stdout.Write(data)
		_, _ = os.Stderr.Write(data)
		os.Exit(0)
	case "wait":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
}
