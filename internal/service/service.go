// Package service controls the installation-owned daemon through its bundled CLI.
// No child receiver is launched by the desktop, and quitting the desktop does not stop it.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/idy/nootify/internal/storage"
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
	Service     string   `json:"service"`
	Backend     string   `json:"backend"`
	Modules     []Module `json:"modules"`
	UITransport int      `json:"ui_transport"`
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

// Bundled identifies the single executable that supplies desktop, CLI and daemon.
type Bundled struct{ Executable string }

func Locate(executable, platform string) *Bundled {
	dir := filepath.Dir(executable)
	if platform == "windows" {
		return &Bundled{Executable: executable}
	}
	if platform != "darwin" || filepath.Base(dir) != "MacOS" || filepath.Base(filepath.Dir(dir)) != "Contents" || filepath.Ext(filepath.Dir(filepath.Dir(dir))) != ".app" {
		return nil
	}
	return &Bundled{Executable: executable}
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
	info, err := os.Stat(b.Executable)
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("this app bundle has no executable %s", b.Executable)
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
	StateDir string
	Bundle   *Bundled
	platform string
	run      Runner
	address  string
	mu       sync.Mutex
	checked  time.Time
	present  bool
	drain    *drainProcess
}

type drainProcess struct {
	PID     int    `json:"pid"`
	Started string `json:"started"`
}

func New(home string, bundle *Bundled) *Manager {
	directory, _ := filepath.Abs(storage.DefaultDir())
	return &Manager{Home: home, StateDir: directory, Bundle: bundle, platform: runtime.GOOS, run: Run, address: "127.0.0.1:9417"}
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
		if readOnlyVolume(m.Bundle.Executable) {
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
	// The CLI checks exact executable/state paths, plist/task ownership, occupied port,
	// and the original process's start time before changing an existing registration.
	_, err := m.execute(ctx, action, false)
	return err
}
func (m *Manager) execute(ctx context.Context, action string, install bool) (Output, error) {
	if m.Bundle == nil {
		return Output{}, errors.New("development builds do not bundle the service")
	}
	args := []string{"service-" + action, "--state-dir", m.StateDir}
	var draining bool
	if m.platform == "darwin" && (action == "start" || action == "restart" || action == "stop") {
		m.mu.Lock()
		if m.drain != nil {
			data, _ := json.Marshal(m.drain)
			args = append(args, "--service-drain", string(data))
			draining = true
		}
		m.mu.Unlock()
	}
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
	out := m.run(ctx, Command{m.Bundle.Executable, args, cleanEnvironment(m.platform, m.Home, os.Environ()), m.Home, timeout})
	if out.Err != nil {
		return out, commandError(out)
	}
	if draining {
		m.mu.Lock()
		m.drain = nil
		m.mu.Unlock()
	}
	return out, nil
}

// QuiesceForRollback proves registration ownership even when a partial start has
// already unloaded itself. Its success permits resource rollback, not a restart.
func (m *Manager) QuiesceForRollback(ctx context.Context) error {
	installed, err := m.Installed(ctx)
	if err != nil {
		return err
	}
	if !installed {
		return errors.New("replacement service registration disappeared before rollback")
	}
	_, err = m.execute(ctx, "stop", false)
	return err
}

// StopForUpdate is deliberately checked by the installation CLI, never by process name.
// A missing registration needs no stop. An unreadable/foreign registration blocks replacement.
func (m *Manager) StopForUpdate(ctx context.Context) (bool, error) {
	installed, err := m.Installed(ctx)
	if err != nil {
		return false, err
	}
	if !installed {
		m.mu.Lock()
		draining := m.drain != nil
		m.mu.Unlock()
		if draining {
			return false, errors.New("owned process drain is pending but its service registration disappeared")
		}
		return false, nil
	}
	out, err := m.execute(ctx, "stop", false)
	if err != nil {
		if m.platform == "darwin" {
			lines := strings.Split(strings.TrimSpace(out.Stderr), "\n")
			for i := len(lines) - 1; i >= 0; i-- {
				var failure struct {
					Error    string        `json:"error"`
					Unloaded bool          `json:"service_unloaded"`
					Process  *drainProcess `json:"service_process"`
				}
				if json.Unmarshal([]byte(lines[i]), &failure) != nil || failure.Error == "" {
					continue
				}
				p := failure.Process
				if failure.Unloaded && p != nil && p.PID > 0 && p.Started != "" && len(p.Started) <= 128 && !strings.ContainsAny(p.Started, "\r\n") {
					m.mu.Lock()
					m.drain = p
					m.mu.Unlock()
					return true, err // owned bootout succeeded; recovery still must drain
				}
				break // Only the CLI's final structured error is authoritative.
			}
		}
		return false, err
	}
	var result struct {
		WasRunning *bool `json:"was_running"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out.Stdout)), &result) != nil || result.WasRunning == nil {
		return false, errors.New("background service stop did not report its previous running state")
	}
	return *result.WasRunning, nil
}
