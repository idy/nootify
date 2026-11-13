package service

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

type testExit int

func (e testExit) Error() string { return "synthetic command failure" }
func (e testExit) ExitCode() int { return int(e) }
func launchdFixture(t *testing.T, legacy bool) (Options, map[string]any, launchdRuntime, string) {
	t.Helper()
	home := t.TempDir()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	options := Options{Executable: filepath.Join(home, "Nootify.app", "Contents", "MacOS", "Nootify"), StateDir: filepath.Join(home, "state"), Port: port}
	args := []string{options.Executable, "serve", "--state-dir", options.StateDir, "--port", strconv.Itoa(options.Port), "--mcp-config", filepath.Join(home, "old-mcp.json")}
	if legacy {
		args[0] = filepath.Join(filepath.Dir(options.Executable), "node")
		args[1] = filepath.Join(filepath.Dir(filepath.Dir(options.Executable)), "Resources", "service", "dist", "src", "server.js")
	}
	plist := map[string]any{"Label": Label, "ProgramArguments": args, "WorkingDirectory": options.StateDir, "StandardOutPath": filepath.Join(options.StateDir, "stdout.log"), "StandardErrorPath": filepath.Join(options.StateDir, "stderr.log"), "RunAtLoad": true, "KeepAlive": true, "ThrottleInterval": 10, "ProcessType": "Background", "EnvironmentVariables": map[string]string{"EXAMPLE": "preserve"}}
	path := filepath.Join(home, "Library", "LaunchAgents", Label+".plist")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(plist)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return options, plist, launchdRuntime{home: home, uid: 501, shutdownTimeout: time.Second}, path
}
func TestLaunchdOwnershipAcceptsOnlyExactCurrentOrLegacyBundle(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		options, registration, _, _ := launchdFixture(t, legacy)
		data, _ := json.Marshal(registration)
		_, old, err := ownedLaunchd(data, options)
		if err != nil || old != legacy {
			t.Fatal(old, err)
		}
		for _, mutation := range []string{"executable", "state", "arguments", "program", "environment", "keepalive"} {
			var changed map[string]any
			_ = json.Unmarshal(data, &changed)
			switch mutation {
			case "executable":
				changed["ProgramArguments"].([]any)[0] = "/other/Nootify"
			case "state":
				changed["WorkingDirectory"] = "/other/state"
			case "arguments":
				changed["ProgramArguments"] = append(changed["ProgramArguments"].([]any), "--foreign")
			case "program":
				changed["Program"] = "/bin/other"
			case "environment":
				changed["EnvironmentVariables"] = map[string]any{"KEY": true}
			case "keepalive":
				changed["KeepAlive"] = map[string]bool{"SuccessfulExit": false}
			}
			altered, _ := json.Marshal(changed)
			if assertLaunchdOwnership(altered, options) == nil {
				t.Fatalf("accepted legacy=%v mutation=%s", legacy, mutation)
			}
		}
	}
}
func TestLegacyLaunchdMigrationDrainsBeforeRewriteAndPreservesConfiguration(t *testing.T) {
	options, registration, r, path := launchdFixture(t, true)
	before, _ := os.ReadFile(path)
	loaded := true
	bootedOut := false
	drained := false
	queries := 0
	var calls []Command
	r.run = func(_ context.Context, c Command) Output {
		calls = append(calls, c)
		switch c.Path {
		case "/usr/bin/plutil":
			if slices.Contains(c.Args, "xml1") {
				if !bootedOut || !drained {
					t.Fatal("rewrote before exact process drain")
				}
				return Output{}
			}
			return Output{Stdout: string(before)}
		case "/bin/ps":
			queries++
			if queries >= 3 {
				drained = true
				return Output{Stdout: "different process start"}
			}
			return Output{Stdout: "original process start"}
		case "/bin/launchctl":
			switch c.Args[0] {
			case "print":
				if loaded {
					return Output{Stdout: "pid = 12345\n"}
				}
				return Output{Err: testExit(113), Stderr: `Could not find service "` + Label + `" in domain for user gui: 501`}
			case "bootout":
				bootedOut = true
				loaded = false
				return Output{}
			case "bootstrap":
				if !drained {
					t.Fatal("bootstrapped before drain")
				}
				loaded = true
				return Output{}
			case "kickstart":
				return Output{}
			}
		}
		t.Fatalf("unexpected command %s %v", c.Path, c.Args)
		return Output{}
	}
	result, err := manageLaunchd(context.Background(), "restart", options, r)
	if err != nil || result.Status != "restarted" {
		t.Fatal(result, err)
	}
	backup, err := os.ReadFile(path + ".node-backup")
	if err != nil || string(backup) != string(before) {
		t.Fatal("legacy backup lost", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	next, old, err := ownedLaunchd(after, options)
	if err != nil || old {
		t.Fatal("not migrated to Go", err)
	}
	args := next["ProgramArguments"].([]any)
	if args[0] != options.Executable || args[1] != "serve" || args[7] != registration["ProgramArguments"].([]string)[7] {
		t.Fatal("migration changed executable/MCP", args)
	}
	if next["EnvironmentVariables"].(map[string]any)["EXAMPLE"] != "preserve" {
		t.Fatal("environment was discarded")
	}
	for _, c := range calls {
		if strings.Contains(c.Path, "node") {
			t.Fatal("executed Node", c)
		}
	}
}
func TestLegacyUpdaterHandoffPreservesRegistrationForRollback(t *testing.T) {
	for _, startFails := range []bool{false, true} {
		t.Run(strconv.FormatBool(startFails), func(t *testing.T) {
			options, _, r, path := launchdFixture(t, true)
			options.PreserveLegacyLaunchd = true
			original, _ := os.ReadFile(path)
			loaded := false // The old updater stopped its service before the exchange.
			r.run = func(_ context.Context, c Command) Output {
				switch c.Path {
				case "/usr/bin/plutil":
					if slices.Contains(c.Args, "xml1") {
						return Output{}
					}
					data, err := os.ReadFile(path)
					return Output{Stdout: string(data), Err: err}
				case "/bin/launchctl":
					switch c.Args[0] {
					case "print":
						if loaded {
							return Output{} // A loaded job can have no process yet.
						}
						return Output{Err: testExit(113), Stderr: `Could not find service "` + Label + `" in domain for user gui: 501`}
					case "bootstrap":
						loaded = true
						return Output{}
					case "kickstart":
						if startFails && options.PreserveLegacyLaunchd {
							return Output{Err: testExit(5), Stderr: "synthetic partial start"}
						}
						return Output{}
					case "bootout":
						loaded = false
						return Output{}
					}
				}
				t.Fatalf("unexpected command %s %v", c.Path, c.Args)
				return Output{}
			}
			_, err := manageLaunchd(context.Background(), "start", options, r)
			if (err != nil) != startFails {
				t.Fatal(err)
			}
			if _, err := manageLaunchd(context.Background(), "stop", options, r); err != nil {
				t.Fatal("cannot quiesce replacement for old supervisor rollback", err)
			}
			after, _ := os.ReadFile(path)
			if loaded || string(after) != string(original) {
				t.Fatal("legacy registration changed before GUI commit or rollback")
			}
			if _, err := os.Stat(path + ".node-backup"); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("legacy handoff unexpectedly migrated the registration", err)
			}
			// Once the old transaction is over, an ordinary Go service start may
			// migrate normally. Its exact original registration is still recoverable.
			options.PreserveLegacyLaunchd = false
			if _, err := manageLaunchd(context.Background(), "start", options, r); err != nil {
				t.Fatal("ordinary post-handoff start failed", err)
			}
			after, _ = os.ReadFile(path)
			if _, legacy, err := ownedLaunchd(after, options); err != nil || legacy {
				t.Fatal("ordinary start did not migrate to Go", err)
			}
		})
	}
}

func TestLegacyBridgeStillRefusesForeignLaunchdRegistration(t *testing.T) {
	options, registration, r, path := launchdFixture(t, true)
	options.PreserveLegacyLaunchd = true
	registration["ProgramArguments"].([]string)[0] = "/foreign/Nootify.app/Contents/MacOS/node"
	data, _ := json.Marshal(registration)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	r.run = func(_ context.Context, c Command) Output {
		if c.Path != "/usr/bin/plutil" {
			t.Fatal("legacy bridge controlled a foreign service", c)
		}
		return Output{Stdout: string(data)}
	}
	if _, err := manageLaunchd(context.Background(), "start", options, r); err == nil {
		t.Fatal("legacy compatibility bypassed ownership validation")
	}
}

func TestStopPublishesDrainReceiptOnlyAfterOwnedBootout(t *testing.T) {
	options, registration, r, path := launchdFixture(t, false)
	data, _ := json.Marshal(registration)
	bootedOut := false
	r.shutdownTimeout = time.Millisecond
	r.run = func(_ context.Context, c Command) Output {
		if c.Path == "/usr/bin/plutil" {
			return Output{Stdout: string(data)}
		}
		if c.Path == "/bin/ps" {
			return Output{Stdout: "original start"}
		}
		if c.Args[0] == "print" {
			return Output{Stdout: "pid = 12345\n"}
		}
		if c.Args[0] == "bootout" {
			bootedOut = true
			return Output{}
		}
		t.Fatal(c)
		return Output{}
	}
	_, err := manageLaunchd(context.Background(), "stop", options, r)
	var unloaded *UnloadedError
	if !bootedOut || !errors.As(err, &unloaded) || unloaded.Process.PID != 12345 {
		t.Fatal("lost owned drain proof", err)
	}
	failure := Failure(err)
	if failure["service_unloaded"] != true {
		t.Fatal(failure)
	}
	if _, err = os.Stat(path); err != nil {
		t.Fatal("stop failure removed registration", err)
	}
}
func TestLaunchdQueryErrorsNeverAuthorizeBootstrapOrRemoval(t *testing.T) {
	options, registration, r, path := launchdFixture(t, false)
	data, _ := json.Marshal(registration)
	for _, diagnostic := range []Output{{Err: testExit(5), Stderr: "access denied"}, {Err: testExit(113), Stderr: "unknown"}, {Err: context.DeadlineExceeded, Stderr: `Could not find service "` + Label + `" in domain for user gui: 501`}} {
		commands := 0
		r.run = func(_ context.Context, c Command) Output {
			commands++
			if c.Path == "/usr/bin/plutil" {
				return Output{Stdout: string(data)}
			}
			if c.Path != "/bin/launchctl" || c.Args[0] != "print" {
				t.Fatal("mutated after unknown query", c)
			}
			return diagnostic
		}
		if _, err := manageLaunchd(context.Background(), "uninstall", options, r); err == nil {
			t.Fatal("accepted unknown job query")
		}
		if commands != 2 {
			t.Fatal(commands)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatal("registration removed")
		}
	}
}
func TestInvalidDrainIsRejectedAndTypedFailureCannotBeForged(t *testing.T) {
	for _, value := range []string{`null`, `{"pid":0,"started":"s"}`, `{"pid":1,"started":"s\n"}`, `{"pid":1,"started":""}`} {
		if _, err := parseDrain([]byte(value)); err == nil {
			t.Fatal(value)
		}
	}
	if _, ok := Failure(errors.New("service_unloaded true"))["service_unloaded"]; ok {
		t.Fatal("plain error granted drain authority")
	}
}
