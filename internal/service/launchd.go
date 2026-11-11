package service

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type launchdRuntime struct {
	home            string
	uid             int
	run             Runner
	shutdownTimeout time.Duration
}

func (r launchdRuntime) command(ctx context.Context, path string, args ...string) (Output, error) {
	env := append(cleanEnvironment("darwin", r.home, os.Environ()), "LC_ALL=C")
	out := r.run(ctx, Command{Path: path, Args: args, Env: env, Dir: r.home, Timeout: 10 * time.Second})
	if out.Err != nil {
		return out, commandError(out)
	}
	return out, nil
}
func xmlText(value string) string {
	var result strings.Builder
	_ = xml.EscapeText(&result, []byte(value))
	return result.String()
}
func launchdPlist(options Options) string {
	args := append([]string{options.Executable}, serviceArguments(options, false)...)
	var values strings.Builder
	for _, arg := range args {
		fmt.Fprintf(&values, "<string>%s</string>", xmlText(arg))
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>` + Label + `</string>
<key>ProgramArguments</key><array>` + values.String() + `</array>
<key>WorkingDirectory</key><string>` + xmlText(options.StateDir) + `</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>` + xmlText(filepath.Join(options.StateDir, "stdout.log")) + `</string>
<key>StandardErrorPath</key><string>` + xmlText(filepath.Join(options.StateDir, "stderr.log")) + `</string>
</dict></plist>
`
}

// ownedLaunchd accepts only the exact current binary or the exact prior Node
// layout inside this same app bundle. It never executes that prior runtime.
func ownedLaunchd(data []byte, options Options) (map[string]any, bool, error) {
	var plist map[string]any
	if json.Unmarshal(data, &plist) != nil {
		return nil, false, errors.New("invalid LaunchAgent plist")
	}
	refuse := func() (map[string]any, bool, error) {
		return nil, false, errors.New("refusing to control a LaunchAgent owned by another installation or with modified arguments")
	}
	var args []string
	values, ok := plist["ProgramArguments"].([]any)
	if !ok {
		return refuse()
	}
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			return refuse()
		}
		args = append(args, text)
	}
	expected := append([]string{options.Executable}, serviceArguments(Options{StateDir: options.StateDir, Port: options.Port}, false)...)
	legacy := false
	contents := filepath.Dir(filepath.Dir(options.Executable))
	if Locate(options.Executable, "darwin") != nil {
		old := []string{filepath.Join(contents, "MacOS", "node"), filepath.Join(contents, "Resources", "service", "dist", "src", "server.js"), "--state-dir", options.StateDir, "--port", strconv.Itoa(options.Port)}
		if len(args) >= len(old) && slices.Equal(args[:len(old)], old) {
			expected = old
			legacy = true
		}
	}
	if len(args) != len(expected) && len(args) != len(expected)+2 || len(args) < len(expected) || !slices.Equal(args[:len(expected)], expected) || len(args) > len(expected) && (args[len(expected)] != "--mcp-config" || !filepath.IsAbs(args[len(expected)+1])) || plist["Label"] != Label || plist["WorkingDirectory"] != options.StateDir || plist["StandardOutPath"] != filepath.Join(options.StateDir, "stdout.log") || plist["StandardErrorPath"] != filepath.Join(options.StateDir, "stderr.log") {
		return refuse()
	}
	// A Program override, redirected root or extra launch semantics can defeat exact
	// argv ownership. The generated plist's harmless settings and environment survive.
	allowed := map[string]bool{"Label": true, "ProgramArguments": true, "WorkingDirectory": true, "StandardOutPath": true, "StandardErrorPath": true, "RunAtLoad": true, "KeepAlive": true, "ThrottleInterval": true, "ProcessType": true, "EnvironmentVariables": true}
	for key := range plist {
		if !allowed[key] {
			return refuse()
		}
	}
	if value, ok := plist["RunAtLoad"]; ok && value != true {
		return refuse()
	}
	if value, ok := plist["KeepAlive"]; ok && value != true {
		return refuse()
	}
	if value, ok := plist["EnvironmentVariables"]; ok {
		env, ok := value.(map[string]any)
		if !ok {
			return refuse()
		}
		for _, entry := range env {
			if _, ok := entry.(string); !ok {
				return refuse()
			}
		}
	}
	return plist, legacy, nil
}
func assertLaunchdOwnership(data []byte, options Options) error {
	_, _, err := ownedLaunchd(data, options)
	return err
}
func migrateLaunchd(ctx context.Context, path string, options Options, registration map[string]any, r launchdRuntime) error {
	original, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	backup := path + ".node-backup"
	file, err := os.OpenFile(backup, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		previous, e := os.ReadFile(backup)
		if e != nil || string(previous) != string(original) {
			return errors.New("legacy LaunchAgent backup already exists and differs; registration was retained")
		}
	} else if err != nil {
		return err
	} else {
		_, err = file.Write(original)
		if err == nil {
			err = file.Sync()
		}
		err = errors.Join(err, file.Close())
		if err != nil {
			return err
		}
	}
	args := registration["ProgramArguments"].([]any)
	next := append([]string{options.Executable}, serviceArguments(Options{StateDir: options.StateDir, Port: options.Port}, false)...)
	if len(args) == 8 {
		next = append(next, "--mcp-config", args[7].(string))
	}
	registration["ProgramArguments"] = next
	data, err := json.Marshal(registration)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".nootify-plist-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	_, err = temporary.Write(data)
	if err == nil {
		err = temporary.Sync()
	}
	err = errors.Join(err, temporary.Close())
	if err != nil {
		return err
	}
	if _, err = r.command(ctx, "/usr/bin/plutil", "-convert", "xml1", name); err != nil {
		return err
	}
	if err = os.Chmod(name, 0644); err != nil {
		return err
	}
	current, err := os.ReadFile(path)
	if err != nil || string(current) != string(original) {
		return errors.New("LaunchAgent changed during migration; original backup was retained")
	}
	return os.Rename(name, path)
}

func parseDrain(data []byte) (drainProcess, error) {
	var identity drainProcess
	if json.Unmarshal(data, &identity) != nil || identity.PID <= 0 || strings.TrimSpace(identity.Started) == "" || len(identity.Started) > 128 || strings.ContainsAny(identity.Started, "\r\n") {
		return identity, errors.New("invalid service drain identity")
	}
	return identity, nil
}
func launchdIdentity(ctx context.Context, pid int, r launchdRuntime) (*drainProcess, error) {
	out, err := r.command(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=")
	started := strings.TrimSpace(out.Stdout)
	if err == nil && started != "" && !strings.ContainsAny(started, "\r\n") {
		return &drainProcess{PID: pid, Started: started}, nil
	}
	if processAbsent(pid) {
		return nil, nil
	}
	return nil, errors.New("cannot verify the Nootify process identity; the LaunchAgent plist was retained")
}
func waitLaunchdExit(ctx context.Context, identity drainProcess, r launchdRuntime) error {
	deadline := time.Now().Add(r.shutdownTimeout)
	for {
		current, err := launchdIdentity(ctx, identity.PID, r)
		if err != nil {
			return err
		}
		if current == nil || current.Started != identity.Started {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("the Nootify process has not finished shutting down; the LaunchAgent plist was retained")
		}
		if err := waitContext(ctx, 100*time.Millisecond); err != nil {
			return err
		}
	}
}

var launchdPID = regexp.MustCompile(`(?m)^\s*pid\s*=\s*(\S+)\s*$`)

func queryLaunchd(ctx context.Context, r launchdRuntime, target string) (string, bool, error) {
	out, err := r.command(ctx, "/bin/launchctl", "print", target)
	if err == nil {
		return out.Stdout, true, nil
	}
	// Only the documented no-such-service exit and exact diagnostic prove unloaded.
	missing := fmt.Sprintf("Could not find service %q in domain for user gui: %d", Label, r.uid)
	code := 0
	var exit interface{ ExitCode() int }
	if errors.As(out.Err, &exit) {
		code = exit.ExitCode()
	}
	detail := strings.TrimSpace(out.Stderr)
	if code != 113 || out.Stdout != "" || detail != missing && detail != "Bad request.\n"+missing {
		return "", false, errors.New("cannot query the Nootify LaunchAgent; the plist was retained and no service action was performed")
	}
	return "", false, nil
}
func manageLaunchd(ctx context.Context, action string, options Options, r launchdRuntime) (Result, error) {
	plist := filepath.Join(r.home, "Library", "LaunchAgents", Label+".plist")
	domain := fmt.Sprintf("gui/%d", r.uid)
	target := domain + "/" + Label
	if action == "install" {
		// A new install never rewrites an existing or redirected registration.
		if _, err := os.Lstat(plist); !errors.Is(err, os.ErrNotExist) {
			return Result{}, fmt.Errorf("%s already exists and is never rewritten", plist)
		}
		if readOnlyVolume(options.Executable) {
			return Result{}, errors.New("Nootify.app is on a read-only volume; move it to /Applications and reopen it")
		}
		if err := assertPortFree(options.Port); err != nil {
			return Result{}, err
		}
		if err := os.MkdirAll(options.StateDir, 0700); err != nil {
			return Result{}, err
		}
		if err := os.Chmod(options.StateDir, 0700); err != nil {
			return Result{}, err
		}
		if err := os.MkdirAll(filepath.Dir(plist), 0755); err != nil {
			return Result{}, err
		}
		file, err := os.OpenFile(plist, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err != nil {
			return Result{}, err
		}
		_, err = file.WriteString(launchdPlist(options))
		if err == nil {
			err = file.Sync()
		}
		err = errors.Join(err, file.Close())
		if err != nil {
			return Result{}, err
		}
		if _, err = r.command(ctx, "/usr/bin/plutil", "-lint", plist); err != nil {
			return Result{}, err
		}
		if _, err = r.command(ctx, "/bin/launchctl", "bootstrap", domain, plist); err != nil {
			return Result{}, err
		}
		for attempt := 0; attempt < 30; attempt++ {
			if _, err = CheckHealth(ctx, HealthClient(), fmt.Sprintf("http://127.0.0.1:%d/", options.Port)); err == nil {
				return Result{Installed: true, Status: "installed", Plist: plist}, nil
			}
			if err = waitContext(ctx, 200*time.Millisecond); err != nil {
				return Result{}, err
			}
		}
		return Result{}, fmt.Errorf("LaunchAgent loaded but health is not ready; inspect %s", filepath.Join(options.StateDir, "stderr.log"))
	}
	installed := true
	info, err := os.Lstat(plist)
	if errors.Is(err, os.ErrNotExist) {
		installed = false
	} else if err != nil {
		return Result{}, err
	} else if !info.Mode().IsRegular() {
		return Result{}, errors.New("refusing redirected LaunchAgent plist")
	}
	var registration map[string]any
	legacy := false
	if installed {
		out, err := r.command(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", plist)
		if err != nil {
			return Result{}, err
		}
		if registration, legacy, err = ownedLaunchd([]byte(out.Stdout), options); err != nil {
			return Result{}, err
		}
	}
	if len(options.Drain) > 0 {
		identity, err := parseDrain(options.Drain)
		if err != nil {
			return Result{}, err
		}
		if err = waitLaunchdExit(ctx, identity, r); err != nil {
			return Result{}, err
		}
	}
	if !installed {
		if action == "status" {
			return Result{Installed: false, Running: boolPointer(false)}, nil
		}
		if action == "uninstall" || action == "stop" {
			return Result{Installed: false, WasRunning: boolPointer(len(options.Drain) > 0), Status: map[string]string{"stop": "stopped", "uninstall": "uninstalled"}[action]}, nil
		}
		return Result{}, errors.New("Nootify is not installed; use service-install")
	}
	job, loaded, err := queryLaunchd(ctx, r, target)
	if err != nil {
		return Result{}, err
	}
	if action == "status" {
		return Result{Installed: true, Running: boolPointer(loaded)}, nil
	}
	if action == "start" || action == "restart" {
		// A restart drains the original identity before starting its replacement.
		// Legacy jobs are migrated while unloaded, never kickstarted through Node.
		if loaded && (action == "restart" || legacy) {
			if _, err = manageLaunchd(ctx, "stop", options, r); err != nil {
				return Result{}, err
			}
			loaded = false
		}
		if !loaded {
			if err = assertPortFree(options.Port); err != nil {
				return Result{}, err
			}
			if legacy {
				if err = migrateLaunchd(ctx, plist, options, registration, r); err != nil {
					return Result{}, err
				}
			}
			if _, err = r.command(ctx, "/bin/launchctl", "bootstrap", domain, plist); err != nil {
				return Result{}, err
			}
		}
		if _, err = r.command(ctx, "/bin/launchctl", "kickstart", target); err != nil {
			return Result{}, err
		}

	} else if action == "stop" || action == "uninstall" {
		if loaded {
			var identity *drainProcess
			if match := launchdPID.FindStringSubmatch(job); match != nil {
				pid, e := strconv.Atoi(match[1])
				if e != nil || pid <= 0 {
					return Result{}, errors.New("cannot verify the Nootify launchd process ID")
				}
				identity, err = launchdIdentity(ctx, pid, r)
				if err != nil {
					return Result{}, err
				}
			}
			if _, err = r.command(ctx, "/bin/launchctl", "bootout", target); err != nil {
				return Result{}, err
			}
			if identity != nil {
				if err = waitLaunchdExit(ctx, *identity, r); err != nil {
					return Result{}, &UnloadedError{Cause: err, Process: *identity}
				}
			}
		}
		if action == "uninstall" {
			if err = os.Remove(plist); err != nil {
				return Result{}, err
			}
		}
	} else {
		return Result{}, errors.New("service enable/disable is only supported on Windows")
	}
	result := Result{Installed: action != "uninstall", Status: map[string]string{"start": "started", "restart": "restarted", "stop": "stopped", "uninstall": "uninstalled"}[action], Plist: plist}
	if action == "stop" || action == "uninstall" {
		result.WasRunning = boolPointer(loaded || len(options.Drain) > 0)
	}
	return result, nil
}
