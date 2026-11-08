// Package service controls the installation-owned daemon through its bundled CLI.
// No child receiver is launched by the desktop, and quitting the desktop does not stop it.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode"
)

const URL = "http://127.0.0.1:9417/"
const Label = "dev.idy.nootify.service"
const outputLimit = 64 * 1024

type Module struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}
type Health struct {
	Service string   `json:"service"`
	Modules []Module `json:"modules"`
}

func HealthClient() *http.Client {
	return &http.Client{Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: time.Second}).DialContext}, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func CheckHealth(ctx context.Context, client *http.Client, base string) (Health, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/health", nil)
	if err != nil {
		return Health{}, err
	}
	response, err := client.Do(req)
	if err != nil {
		return Health{}, fmt.Errorf("cannot connect: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Health{}, fmt.Errorf("health returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, outputLimit+1))
	if err != nil {
		return Health{}, err
	}
	return ParseHealth(data)
}
func ParseHealth(data []byte) (Health, error) {
	var h Health
	if len(data) > outputLimit {
		return h, errors.New("health response exceeds 64 KiB")
	}
	if err := json.Unmarshal(data, &h); err != nil {
		return h, fmt.Errorf("invalid health response: %w", err)
	}
	if h.Service != "nootify" {
		return h, errors.New("port is not serving Nootify")
	}
	if h.Modules == nil {
		return h, errors.New("health response has no modules")
	}
	for _, m := range h.Modules {
		if m.Name == "" || m.Status == "" {
			return h, errors.New("invalid health module")
		}
	}
	return h, nil
}
func MenuText(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if !unicode.IsControl(r) {
			b.WriteRune(r)
			n++
			if n == 180 {
				break
			}
		}
	}
	return b.String()
}

type Bundled struct{ Node, CLI string }

func Locate(executable, platform string) *Bundled {
	dir := filepath.Dir(executable)
	if platform == "windows" {
		return &Bundled{filepath.Join(dir, "node.exe"), filepath.Join(dir, "service", "dist", "src", "cli.js")}
	}
	if platform != "darwin" || filepath.Base(dir) != "MacOS" || filepath.Base(filepath.Dir(dir)) != "Contents" || filepath.Ext(filepath.Dir(filepath.Dir(dir))) != ".app" {
		return nil
	}
	return &Bundled{filepath.Join(dir, "node"), filepath.Join(filepath.Dir(dir), "Resources", "service", "dist", "src", "cli.js")}
}
func Current() (*Bundled, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return nil, err
	}
	b := Locate(exe, runtime.GOOS)
	if b == nil {
		return nil, nil
	}
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
		if _, err := os.Stat(b.Node); errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
	}
	for _, p := range []string{b.Node, b.CLI, filepath.Join(filepath.Dir(b.Node), "nootify-core"+suffix), filepath.Join(filepath.Dir(b.Node), "nootify-tsnet"+suffix)} {
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("this app bundle has no %s", p)
		}
	}
	return b, nil
}

type Command struct {
	Path      string
	Args, Env []string
	Dir       string
	Timeout   time.Duration
}
type Output struct {
	Stdout, Stderr string
	Err            error
}
type Runner func(context.Context, Command) Output

// cappedWriter continues draining after the retained prefix is full.
type cappedWriter struct{ data []byte }

func (w *cappedWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.data = append(w.data, p[:min(len(p), outputLimit-len(w.data))]...)
	return n, nil
}
func Run(ctx context.Context, c Command) Output {
	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Path, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = c.Env
	cmd.WaitDelay = 2 * time.Second
	hideConsole(cmd)
	var out, errout cappedWriter
	cmd.Stdout = &out
	cmd.Stderr = &errout
	err := cmd.Run()
	if ctx.Err() != nil {
		err = fmt.Errorf("command timed out: %w", ctx.Err())
	}
	return Output{string(out.data), string(errout.data), err}
}
func cleanEnvironment(platform, home string, ambient []string) []string {
	allowed := map[string]bool{}
	if platform == "windows" {
		for _, k := range []string{"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERNAME", "USERDOMAIN"} {
			allowed[k] = true
		}
	} else {
		for _, k := range []string{"USER", "LOGNAME", "TMPDIR"} {
			allowed[k] = true
		}
	}
	result := []string{"HOME=" + home}
	if platform != "windows" {
		result = append(result, "PATH=/usr/bin:/bin:/usr/sbin:/sbin")
	}
	for _, entry := range ambient {
		k, _, ok := strings.Cut(entry, "=")
		if ok && allowed[strings.ToUpper(k)] {
			result = append(result, entry)
		}
	}
	return result
}
func commandError(out Output) error {
	lines := strings.Split(strings.TrimSpace(out.Stderr), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(lines[i]), &e) == nil && e.Error != "" {
			return errors.New(e.Error)
		}
	}
	if s := strings.TrimSpace(out.Stderr); s != "" {
		return errors.New(MenuText(s))
	}
	return out.Err
}

type Manager struct {
	Home     string
	Bundle   *Bundled
	platform string
	run      Runner
	address  string
	mu       sync.Mutex
	checked  time.Time
	present  bool
}

func New(home string, bundle *Bundled) *Manager {
	return &Manager{Home: home, Bundle: bundle, platform: runtime.GOOS, run: Run, address: "127.0.0.1:9417"}
}
func (m *Manager) plist() string {
	return filepath.Join(m.Home, "Library", "LaunchAgents", Label+".plist")
}
func (m *Manager) Installed(ctx context.Context) (bool, error) {
	if m.platform == "darwin" {
		_, err := os.Lstat(m.plist())
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return true, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.checked.IsZero() && time.Since(m.checked) < 15*time.Second {
		return m.present, nil
	}
	out, err := m.execute(ctx, "status", false)
	if err != nil {
		return true, err
	}
	var status struct {
		Installed *bool `json:"installed"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out.Stdout)), &status) != nil || status.Installed == nil {
		return true, errors.New("invalid background service status")
	}
	m.checked = time.Now()
	m.present = *status.Installed
	return m.present, nil
}
func portInUse(address string) bool {
	c, err := net.DialTimeout("tcp", address, 500*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}
func (m *Manager) Install(ctx context.Context) error {
	if m.Bundle == nil {
		return errors.New("development builds do not bundle the service")
	}
	if m.platform == "darwin" {
		if _, err := os.Lstat(m.plist()); !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s already exists and is never rewritten", m.plist())
		}
		if portInUse(m.address) {
			return errors.New("127.0.0.1:9417 is already in use; the existing service was left running")
		}
		if readOnlyVolume(m.Bundle.Node) {
			return errors.New("Nootify.app is on a read-only volume; move it to /Applications and reopen it")
		}
	}
	_, err := m.execute(ctx, "install", true)
	return err
}
func (m *Manager) Request(ctx context.Context, action string) error {
	if action != "start" && action != "restart" && action != "stop" {
		return errors.New("invalid background service action")
	}
	// The CLI checks exact node/server/state paths, plist/task ownership, occupied port,
	// and the original process's start time before changing an existing registration.
	_, err := m.execute(ctx, action, false)
	return err
}
func (m *Manager) execute(ctx context.Context, action string, install bool) (Output, error) {
	if m.Bundle == nil {
		return Output{}, errors.New("development builds do not bundle the service")
	}
	args := []string{m.Bundle.CLI, "service-" + action}
	if install {
		p := filepath.Join(m.Home, ".claude.json")
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() {
			args = append(args, "--mcp-config", p)
		}
	}
	timeout := 155 * time.Second
	if action == "status" {
		timeout = 10 * time.Second
	}
	out := m.run(ctx, Command{m.Bundle.Node, args, cleanEnvironment(m.platform, m.Home, os.Environ()), m.Home, timeout})
	if out.Err != nil {
		return out, commandError(out)
	}
	return out, nil
}

// StopForUpdate is deliberately checked by the installation CLI, never by process name.
// A missing registration needs no stop. An unreadable/foreign registration blocks replacement.
func (m *Manager) StopForUpdate(ctx context.Context) (bool, error) {
	installed, err := m.Installed(ctx)
	if err != nil || !installed {
		return false, err
	}
	if err := m.Request(ctx, "stop"); err != nil {
		return false, err
	}
	return true, nil
}
