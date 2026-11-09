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
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

type installedService struct{ target string }

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

func runHidden(file string, arguments ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 170*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, file, arguments...)
	cmd.Env = installerEnvironment()
	hideWindow(cmd)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// Do not include exec errors or stderr: package paths, environment values,
	// and user service configuration do not belong in installer diagnostics.
	if err := cmd.Run(); err != nil {
		return nil, errors.New("owned service command failed or timed out")
	}
	return bytes.TrimPrefix(bytes.TrimSpace(stdout.Bytes()), []byte{0xef, 0xbb, 0xbf}), nil
}

func (s installedService) command(action string) ([]byte, error) {
	return runHidden(filepath.Join(s.target, "node.exe"), filepath.Join(s.target, "service", "dist", "src", "cli.js"), "service-"+action)
}

func (s installedService) running() (bool, error) {
	if !exists(filepath.Join(s.target, "node.exe")) && !exists(filepath.Join(s.target, "service")) {
		return false, nil
	}
	data, err := s.command("status") // Validates exact bundled task ownership first.
	if err != nil {
		return false, err
	}
	var status struct {
		Installed *bool `json:"installed"`
		Running   *bool `json:"running"`
	}
	if err := json.Unmarshal(data, &status); err != nil || status.Installed == nil {
		return false, errors.New("invalid installed service status")
	}
	if !*status.Installed {
		return false, nil
	}
	if status.Running != nil {
		return *status.Running, nil
	}
	// Published older CLIs return only installed. Task registration is not
	// evidence of a running service. Read Scheduler's hidden-inclusive snapshot
	// after the bundled CLI's ownership check; do not modify a task through COM.
	script := `$ErrorActionPreference='Stop'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); $s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $name='Nootify.Service.'+$sid; $task=$s.GetFolder('\').GetTask($name); $all=$s.GetRunningTasks(1); if($null -eq $all.Count){throw 'Missing instance count'}; $count=0; for($i=1;$i -le $all.Count;$i++){ $path=[string]$all.Item($i).Path; if(!$path){throw 'Missing task path'}; if([string]::Equals($path,'\'+$name,[StringComparison]::OrdinalIgnoreCase)){$count++} }; @{running=[bool]($count -gt 0 -or $task.State -eq 4 -or $task.State -eq 2)} | ConvertTo-Json -Compress`
	encoded := utf16.Encode([]rune(script))
	buffer := make([]byte, 2*len(encoded))
	for i, unit := range encoded {
		binary.LittleEndian.PutUint16(buffer[2*i:], unit)
	}
	powerShell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if !filepath.IsAbs(powerShell) {
		return false, errors.New("missing absolute system PowerShell path")
	}
	data, err = runHidden(powerShell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(buffer))
	if err != nil {
		return false, errors.New("cannot query the installed service running state")
	}
	var snapshot struct {
		Running *bool `json:"running"`
	}
	if err := json.Unmarshal(data, &snapshot); err != nil || snapshot.Running == nil {
		return false, errors.New("invalid service running-state snapshot")
	}
	return *snapshot.Running, nil
}

func (s installedService) stop() error {
	if !exists(filepath.Join(s.target, "node.exe")) && !exists(filepath.Join(s.target, "service")) {
		return nil
	}
	_, err := s.command("stop")
	return err
}
func (s installedService) start() error { _, err := s.command("start"); return err }

func main() {
	action := flag.String("action", "", "prepare, apply, recover or finish")
	target := flag.String("target", "", "absolute registered installation directory")
	manifest := flag.String("manifest", "", "trusted staged payload manifest")
	flag.Parse()
	if flag.NArg() != 0 || !filepath.IsAbs(*target) {
		fmt.Fprintln(os.Stderr, "An absolute installer target is required")
		os.Exit(1)
	}
	unlock, lockErr := lockTransaction()
	if lockErr != nil {
		fmt.Fprintln(os.Stderr, lockErr)
		os.Exit(1)
	}
	defer unlock()
	t := transaction{target: filepath.Clean(*target), service: installedService{target: filepath.Clean(*target)}}
	var err error
	switch *action {
	case "prepare":
		err = t.prepare()
	case "apply":
		err = t.apply(*manifest)
	case "recover":
		err = t.recover()
	case "finish":
		err = t.finish()
	default:
		err = errors.New("unknown installer transaction action")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
