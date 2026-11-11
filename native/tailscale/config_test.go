package tailscale

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"tailscale.com/envknob"
)

func TestValidateTarget(t *testing.T) {
	for _, raw := range []string{"tcp://127.0.0.1:1", "tcp://127.0.0.1:53421", "tcp://127.0.0.1:65535"} {
		t.Run(raw, func(t *testing.T) {
			got, err := validateTarget(raw)
			if err != nil || got != strings.TrimPrefix(raw, "tcp://") {
				t.Fatalf("validateTarget() = %q, %v", got, err)
			}
		})
	}
	if got, err := validateTarget("tcp://127.0.0.1:00080"); err != nil || got != "127.0.0.1:80" {
		t.Fatalf("leading-zero port = %q, %v", got, err)
	}
	for _, raw := range []string{
		"", "127.0.0.1:1234", "http://127.0.0.1:1234", "tcp://localhost:1234",
		"tcp://127.1:1234", "tcp://127.0.0.2:1234", "tcp://0.0.0.0:1234",
		"tcp://100.64.0.1:1234", "tcp://[::1]:1234", "tcp://127.0.0.1",
		"tcp://127.0.0.1:0", "tcp://127.0.0.1:65536", "tcp://127.0.0.1:-1",
		"tcp://127.0.0.1:+1234", "tcp://127.0.0.1:http", "tcp://127.0.0.1:1234/",
		"tcp://user:secret@127.0.0.1:1234", "tcp://127.0.0.1:1234?x=1",
		"tcp://127.0.0.1:1234?", "tcp://127.0.0.1:1234#", "tcp://127.0.0.1:1234#x",
		"tcp://127.0.0.1:1234\r\n", "tcp://127.0.0.1%2f:1234", "tcp://[127.0.0.1]:1234",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := validateTarget(raw); err == nil {
				t.Fatalf("accepted unsafe target %q", raw)
			}
		})
	}
}

func TestParseArgs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node")
	base := []string{"--state-dir", path, "--target", "tcp://127.0.0.1:12345"}
	cfg, err := parseArgs(base)
	if err != nil || cfg.hostname != "nootify" || cfg.stateDir != path || cfg.target != "127.0.0.1:12345" {
		t.Fatalf("parseArgs = %#v, %v", cfg, err)
	}
	for _, args := range [][]string{
		nil,
		{"--state-dir", "relative", "--target", "tcp://127.0.0.1:12345"},
		{"--state-dir", "/", "--target", "tcp://127.0.0.1:12345"},
		append(append([]string{}, base...), "positional"),
		append(append([]string{}, base...), "--auth-key", "secret"),
		append(append([]string{}, base...), "--hostname", ""),
		append(append([]string{}, base...), "--hostname", "-nootify"),
		append(append([]string{}, base...), "--hostname", "nootify.example"),
		append(append([]string{}, base...), "--hostname", "bad\nname"),
		append(append([]string{}, base...), "--hostname", strings.Repeat("x", 64)),
	} {
		if _, err := parseArgs(args); err == nil {
			t.Errorf("accepted invalid arguments %q", args)
		}
	}
}

type writeBuffer struct{ bytes.Buffer }

func (*writeBuffer) Close() error { return nil }

func TestVersionDoesNotCreateStateOrStartNetworking(t *testing.T) {
	var stdout writeBuffer
	var stderr bytes.Buffer
	path := filepath.Join(t.TempDir(), "must-not-be-created")
	code := run([]string{"--version", "--state-dir", path}, io.NopCloser(strings.NewReader("")), &stdout, &stderr)
	if code != 0 || stdout.String() != helperVersion()+"\n" || stderr.Len() != 0 {
		t.Fatalf("version output = exit %d, %q, %q", code, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("--version touched state: %v", err)
	}
}

func TestArgumentErrorsNeverEchoInput(t *testing.T) {
	var stdout writeBuffer
	var stderr bytes.Buffer
	code := run([]string{"--auth-key=secret-do-not-log"}, io.NopCloser(strings.NewReader("")), &stdout, &stderr)
	if code != 2 || stdout.Len() != 0 || stderr.String() != "nootify-tsnet: invalid_arguments\n" {
		t.Fatalf("unsafe error output = exit %d, %q, %q", code, stdout.String(), stderr.String())
	}
}

func TestPrepareStateDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state")
	lock, err := prepareStateDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "tailscaled.state")
	if err := os.WriteFile(file, []byte("private-test-state"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0644); err != nil {
		t.Fatal(err)
	}
	lock, err = prepareStateDir(root)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{root: 0700, file: 0600, filepath.Join(root, stateLockName): 0600} {
			stat, err := os.Stat(path)
			if err != nil || stat.Mode().Perm() != want {
				t.Fatalf("permissions %s: %v, %v", path, stat, err)
			}
		}
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "private-test-state" {
		t.Fatalf("existing state changed: %q, %v", data, err)
	}
}

func TestPrepareStateDirRejectsLinksWithoutChangingTargets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows link and DACL invariants are covered by state_windows_test.go")
	}
	for _, kind := range []string{"root-symlink", "root-symlink-slash", "directory-symlink", "file-symlink", "hardlink", "lock-symlink", "lock-hardlink"} {
		t.Run(kind, func(t *testing.T) {
			base := t.TempDir()
			state := filepath.Join(base, "state")
			outside := filepath.Join(base, "outside")
			if err := os.Mkdir(outside, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(outside, 0755); err != nil {
				t.Fatal(err)
			}
			original := filepath.Join(outside, "original")
			if err := os.WriteFile(original, []byte("secret"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(original, 0644); err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(kind, "root-symlink") {
				if err := os.Symlink(outside, state); err != nil {
					t.Fatal(err)
				}
				if strings.HasSuffix(kind, "-slash") {
					state += string(filepath.Separator)
				}
			} else {
				if err := os.Mkdir(state, 0700); err != nil {
					t.Fatal(err)
				}
				name := "tailscaled.state"
				if strings.HasPrefix(kind, "lock-") {
					name = stateLockName
				}
				var err error
				switch {
				case kind == "directory-symlink":
					err = os.Symlink(outside, filepath.Join(state, "subdirectory"))
				case strings.HasSuffix(kind, "hardlink"):
					err = os.Link(original, filepath.Join(state, name))
				default:
					err = os.Symlink(original, filepath.Join(state, name))
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			if lock, err := prepareStateDir(state); err == nil {
				lock.Close()
				t.Fatal("accepted linked state")
			}
			for path, want := range map[string]os.FileMode{outside: 0755, original: 0644} {
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm() != want {
					t.Fatalf("changed linked target permissions: %s = %v, %v", path, info, err)
				}
			}
			data, err := os.ReadFile(original)
			if err != nil || string(data) != "secret" {
				t.Fatalf("changed linked target contents: %q, %v", data, err)
			}
			if _, err := os.Stat(filepath.Join(outside, stateLockName)); !os.IsNotExist(err) {
				t.Fatalf("created lock outside state: %v", err)
			}
		})
	}
}

func TestStateLockExcludesOtherProcessesAndSurvivesStateReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state")
	lock, err := prepareStateDir(path)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	before, err := os.Stat(filepath.Join(path, stateLockName))
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(path, "tailscaled.state")
	if err := os.WriteFile(state, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(path, "replacement")
	if err := os.WriteFile(replacement, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, state); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	runChild := func(want string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, executable, "-test.run=^TestStateLockProcess$")
		cmd.Env = append(os.Environ(), "NOOTIFY_TEST_STATE_DIR="+path, "NOOTIFY_TEST_STATE_LOCK="+want)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("lock subprocess (%s): %v\n%s", want, err, output)
		}
	}
	runChild("locked")
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	runChild("available")
	after, err := os.Stat(filepath.Join(path, stateLockName))
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("lock file was removed/replaced: %v", err)
	}
}

// The child only tests filesystem locking; it never constructs a tsnet node.
func TestStateLockProcess(t *testing.T) {
	want := os.Getenv("NOOTIFY_TEST_STATE_LOCK")
	if want == "" {
		return
	}
	lock, err := prepareStateDir(os.Getenv("NOOTIFY_TEST_STATE_DIR"))
	if lock != nil {
		defer lock.Close()
	}
	if want == "locked" && !errors.Is(err, errStateLocked) {
		t.Fatalf("contender did not fail nonblocking with state_locked: %v", err)
	}
	if want == "available" && err != nil {
		t.Fatalf("lock was not released on close: %v", err)
	}
}

func TestPrivateEnvironmentDisablesAmbientAuth(t *testing.T) {
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "TS_") || strings.HasPrefix(name, "TSNET_") || strings.HasPrefix(name, "TAILSCALE_") {
			envknob.SetenvForTest(t, name, value)
		}
	}
	for _, name := range []string{"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE", "TS_CONTROL_URL", "TAILSCALE_USE_WIP_CODE"} {
		t.Setenv(name, "must-not-be-used")
	}
	envknob.SetenvForTest(t, "TSNET_FORCE_LOGIN", "true")
	force := envknob.RegisterBool("TSNET_FORCE_LOGIN")
	t.Setenv("NOOTIFY_UNRELATED", "preserved")
	privateEnvironment()
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "TS_") || strings.HasPrefix(name, "TSNET_") || strings.HasPrefix(name, "TAILSCALE_") {
			t.Errorf("Tailscale environment variable remains: %s", name)
		}
	}
	if force() {
		t.Fatal("envknob cached forced login is still enabled")
	}
	if os.Getenv("NOOTIFY_UNRELATED") != "preserved" {
		t.Fatal("unrelated environment was modified")
	}
}

func TestPrivateEnvironmentClearsWindowsMixedCaseValuesAndCaches(t *testing.T) {
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		canonical := strings.ToUpper(name)
		if strings.HasPrefix(canonical, "TS_") || strings.HasPrefix(canonical, "TSNET_") || strings.HasPrefix(canonical, "TAILSCALE_") {
			envknob.SetenvForTest(t, name, value)
			if canonical != name {
				envknob.SetenvForTest(t, canonical, os.Getenv(canonical))
			}
		}
	}
	variables := []struct{ name, canonical string }{
		{"ts_authkey", "TS_AUTHKEY"},
		{"Ts_Client_Secret", "TS_CLIENT_SECRET"},
		{"tAiLsCaLe_TeSt_ToKeN", "TAILSCALE_TEST_TOKEN"},
	}
	var cached []func() string
	for _, variable := range variables {
		envknob.SetenvForTest(t, variable.canonical, "cached-credential")
		canonicalCache := envknob.RegisterString(variable.canonical)
		// Recreate the OS entry with mixed spelling while leaving the uppercase
		// initialization cache populated, independent of Windows name retention.
		if err := os.Unsetenv(variable.canonical); err != nil {
			t.Fatal(err)
		}
		envknob.SetenvForTest(t, variable.name, "ambient-credential")
		cached = append(cached, canonicalCache, envknob.RegisterString(variable.name))
	}
	envknob.SetenvForTest(t, "TSNET_FORCE_LOGIN", "true")
	force := envknob.RegisterBool("TSNET_FORCE_LOGIN")
	if err := os.Unsetenv("TSNET_FORCE_LOGIN"); err != nil {
		t.Fatal(err)
	}
	envknob.SetenvForTest(t, "tsnet_force_login", "true")
	mixedForce := envknob.RegisterBool("tsnet_force_login")
	t.Setenv("NOOTIFY_UNRELATED", "preserved")
	// Exercise Windows normalization on every host, including case-sensitive Unix.
	privateEnvironmentForOS("windows")
	for _, variable := range append(variables, struct{ name, canonical string }{"tsnet_force_login", "TSNET_FORCE_LOGIN"}) {
		for _, name := range []string{variable.name, variable.canonical} {
			if _, exists := os.LookupEnv(name); exists {
				t.Errorf("ambient Windows variable remains: %s", name)
			}
		}
	}
	for _, value := range cached {
		if value() != "" {
			t.Error("mixed-case or canonical envknob string cache remains populated")
		}
	}
	if force() || mixedForce() {
		t.Error("mixed-case or canonical forced-login cache remains enabled")
	}
	if os.Getenv("NOOTIFY_UNRELATED") != "preserved" {
		t.Error("unrelated environment was modified")
	}
}
