// Installer-only helper. It never contacts HTTP endpoints or reads credentials.
// NSIS keeps this executable in its temporary plugin directory, outside the
// payload whose executables are exchanged.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/idy/nootify/internal/service"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

type installedService struct {
	target      string
	diagnostics *diagnostics
}

func installerEnvironment() []string {
	var clean []string
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		key = strings.ToUpper(key)
		blocked := false
		for _, prefix := range []string{"NODE_", "LARK_", "SLACK_", "TELEGRAM_", "GITHUB_", "GH_", "CODEX_APP_SERVER_", "OPENCODE_SERVER_", "TS_", "TSNET_", "TAILSCALE_", "NOOTIFY_"} {
			if strings.HasPrefix(key, prefix) {
				blocked = true
				break
			}
		}
		if !blocked {
			clean = append(clean, value)
		}
	}
	return clean
}

func runHidden(d *diagnostics, phase, file string, arguments ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 170*time.Second)
	defer cancel()
	return runHiddenContext(ctx, d, phase, file, arguments...)
}

func runHiddenContext(ctx context.Context, d *diagnostics, phase, file string, arguments ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, file, arguments...)
	cmd.Env = installerEnvironment()
	configurationError := configureCommand(cmd)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// Child output is never diagnostic data. Keep only process exit/deadline and
	// numeric OS failure facts; preserve the existing public failure message.
	d.record(phase, "command", "begin", "", nil, nil)
	err := configurationError
	if err == nil {
		err = cmd.Run()
	}
	if err != nil {
		failure := commandOutput(stdout.Bytes())
		failure.timedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		if cmd.ProcessState != nil {
			code := cmd.ProcessState.ExitCode()
			failure.exitCode = &code
		}
		var errno syscall.Errno
		if errors.As(err, &errno) {
			failure.osErrno = uint64(errno)
		}
		d.record(phase, "command", "failure", "", failure, failure)
		return nil, failure
	}
	code := 0
	facts := commandOutput(stdout.Bytes())
	facts.exitCode = &code
	d.record(phase, "command", "success", "", nil, facts)
	return bytes.TrimPrefix(bytes.TrimSpace(stdout.Bytes()), []byte{0xef, 0xbb, 0xbf}), nil
}

func (s installedService) command(action string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 170*time.Second)
	defer cancel()
	// The helper is compiled with current Go controls, so it can inspect and drain
	// an exact legacy install without executing its obsolete Node or desktop binary.
	s.diagnostics.record(action, "command", "begin", "", nil, nil)
	result, err := service.Manage(ctx, action, service.Options{Executable: filepath.Join(s.target, "Nootify.exe")})
	if err != nil {
		s.diagnostics.record(action, "command", "failure", "", err, nil)
		return nil, errors.New("owned service command failed or timed out")
	}
	s.diagnostics.record(action, "command", "success", "", nil, nil)
	return json.Marshal(result)
}

func (s installedService) snapshot() (serviceState, error) {
	if !exists(filepath.Join(s.target, "Nootify.exe")) {
		return serviceState{}, nil
	}
	data, err := s.command("status") // Validates exact bundled task ownership first.
	if err != nil {
		return serviceState{}, err
	}
	var status struct {
		Installed *bool `json:"installed"`
		Running   *bool `json:"running"`
		Enabled   *bool `json:"enabled"`
	}
	if err := json.Unmarshal(data, &status); err != nil || status.Installed == nil {
		s.diagnostics.invalidResponse("status", data)
		return serviceState{}, errors.New("invalid installed service status")
	}
	if !*status.Installed {
		return serviceState{}, nil
	}
	if status.Running != nil && status.Enabled != nil {
		return serviceState{Running: *status.Running, Enabled: *status.Enabled}, nil
	}
	return s.legacySnapshot()
}

func (s installedService) legacySnapshot() (state serviceState, result error) {
	s.diagnostics.begin("legacy-snapshot", "")
	defer func() { s.diagnostics.end("legacy-snapshot", "", result) }()
	// Published older CLIs return only installed. Task registration is not
	// evidence of a running service. Read Scheduler's hidden-inclusive snapshot
	// after the bundled CLI's ownership check; do not modify a task through COM.
	script := `$ErrorActionPreference='Stop'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); $s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $name='Nootify.Service.'+$sid; $task=$s.GetFolder('\').GetTask($name); $all=$s.GetRunningTasks(1); if($null -eq $all.Count){throw 'Missing instance count'}; $count=0; for($i=1;$i -le $all.Count;$i++){ $path=[string]$all.Item($i).Path; if(!$path){throw 'Missing task path'}; if([string]::Equals($path,'\'+$name,[StringComparison]::OrdinalIgnoreCase)){$count++} }; @{running=[bool]($count -gt 0 -or $task.State -eq 4 -or $task.State -eq 2); enabled=[bool]$task.Enabled} | ConvertTo-Json -Compress`
	data, err := s.powerShell("legacy-snapshot", script)
	if err != nil {
		return state, errors.New("cannot query the installed service state")
	}
	var snapshot struct {
		Running *bool `json:"running"`
		Enabled *bool `json:"enabled"`
	}
	if err := json.Unmarshal(data, &snapshot); err != nil || snapshot.Running == nil || snapshot.Enabled == nil {
		s.diagnostics.invalidResponse("legacy-snapshot", data)
		return state, errors.New("invalid service state snapshot")
	}
	return serviceState{Running: *snapshot.Running, Enabled: *snapshot.Enabled}, nil
}

func (s installedService) powerShell(phase, script string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 170*time.Second)
	defer cancel()
	return s.powerShellContext(ctx, phase, script)
}

func (s installedService) powerShellContext(ctx context.Context, phase, script string) ([]byte, error) {
	encoded := utf16.Encode([]rune(script))
	buffer := make([]byte, 2*len(encoded))
	for i, unit := range encoded {
		binary.LittleEndian.PutUint16(buffer[2*i:], unit)
	}
	powerShell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if !filepath.IsAbs(powerShell) {
		return nil, errors.New("missing absolute system PowerShell path")
	}
	return runHiddenContext(ctx, s.diagnostics, phase, powerShell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(buffer))
}

func (s installedService) enable(enabled bool) error {
	if !exists(filepath.Join(s.target, "Nootify.exe")) {
		return nil
	}
	action := "disable"
	if enabled {
		action = "enable"
	}
	_, err := s.command(action)
	return err
}

func (s installedService) stop() error {
	if !exists(filepath.Join(s.target, "Nootify.exe")) {
		return nil
	}
	_, err := s.command("stop")
	return err
}
func (s installedService) start() error { _, err := s.command("start"); return err }

func (s installedService) preflightDesktop(wait bool) error {
	budget := 10 * time.Second
	if wait {
		budget = 20 * time.Second
	}
	// Include process startup, inspection and retry delays in one deadline.
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	target := powershellPathLiteral(filepath.Join(s.target, "Nootify.exe"))
	script := `$ErrorActionPreference='Stop'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); $target=` + target + `
foreach($p in @(Get-CimInstance Win32_Process -Filter "Name = 'Nootify.exe'")) {
 if($p.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($p.ExecutablePath),$target,[StringComparison]::OrdinalIgnoreCase)) {
  if(!$p.CommandLine -or $p.CommandLine -notmatch '^\s*(?:"[^"]+"|\S+)\s+(?:serve|service-(?:install|start|restart|stop|uninstall|status|enable|disable))(?=\s|$)') { throw 'Close Nootify and retry; an installed desktop process is still running' }
 }
}`
	return inspectDesktop(ctx, wait, func(ctx context.Context) error {
		_, err := s.powerShellContext(ctx, "preflight", script)
		return err
	})
}

func inspectDesktop(ctx context.Context, wait bool, probe func(context.Context) error) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := probe(ctx)
		if canceled := ctx.Err(); canceled != nil {
			return canceled
		}
		if err == nil || !wait {
			return err
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func powershellPathLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func main() {
	action := flag.String("action", "", "prepare, apply, recover, finish or remove")
	target := flag.String("target", "", "absolute registered installation directory")
	manifest := flag.String("manifest", "", "trusted staged payload manifest")
	freshToken := flag.String("fresh-token", "", "pending fresh-install ownership receipt")
	waitDesktop := flag.Bool("wait-desktop", false, "allow up to 20 seconds for an updater desktop handoff")
	flag.Parse()
	d := newDiagnostics(os.Getenv(diagnosticsVariable), *action)
	d.begin("helper", "")
	d.begin("arguments", "")
	if flag.NArg() != 0 || !filepath.IsAbs(*target) {
		err := errors.New("An absolute installer target is required")
		d.end("arguments", "", err)
		d.end("helper", "", err)
		d.close()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	d.end("arguments", "", nil)
	d.begin("lock", "")
	unlock, lockErr := lockTransaction()
	d.end("lock", "", lockErr)
	if lockErr != nil {
		d.end("helper", "", lockErr)
		d.close()
		fmt.Fprintln(os.Stderr, lockErr)
		os.Exit(1)
	}
	defer unlock()
	defer d.close()
	t := transaction{target: filepath.Clean(*target), diagnostics: d, freshToken: *freshToken, service: installedService{target: filepath.Clean(*target), diagnostics: d}}
	var err error
	switch *action {
	case "service-stop":
		_, err = t.service.(installedService).command("stop")
	case "service-uninstall":
		_, err = t.service.(installedService).command("uninstall")
	case "preflight":
		err = t.service.(installedService).preflightDesktop(*waitDesktop)
	case "prepare":
		err = t.prepare()
	case "apply":
		err = t.apply(*manifest)
	case "recover":
		err = t.recover()
	case "finish":
		err = t.finish()
	case "remove":
		err = t.remove()
	default:
		err = errors.New("unknown installer transaction action")
	}
	d.end("helper", "", err)
	if err != nil {
		d.close()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
