// Package updater consumes Nootify's Tauri-compatible signed release feed without a GUI.
package updater

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/semver"
)

const (
	DefaultManifestURL = "https://github.com/idy/nootify/releases/latest/download/latest.json"
	// DefaultPublicKey is the existing installed clients' public key, not a new identity.
	DefaultPublicKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY5QzdDRERFNDgzQjkyNUIKUldSYmtqdEkzczNIK2V1eXVnQzBmR1I5Z3VTRW13eHV0Q2lGRGk5SU51YVlLaDV3eFhqUXl5V0MK"
	checkTimeout     = 30 * time.Second
	downloadTimeout  = 15 * time.Minute
	firstCheck       = 30 * time.Second
	firstJitter      = 15 * time.Second
	checkInterval    = 6 * time.Hour
	checkJitter      = 30 * time.Minute
	retryInterval    = 15 * time.Minute
	retryJitter      = 5 * time.Minute
	tick             = time.Minute
)

var ErrBusy = errors.New("update operation already in progress")
var ErrNoUpdate = errors.New("no update is available")

type View struct {
	Phase     string  `json:"phase"`
	Current   string  `json:"current"`
	Version   *string `json:"version"`
	Received  uint64  `json:"received"`
	Total     *uint64 `json:"total"`
	Error     *string `json:"error"`
	CheckedAt *uint64 `json:"checked_at"`
}

type Options struct {
	Version       string
	ManifestURL   string
	PublicKey     string
	Platform      string
	Executable    string
	BeforeInstall func(context.Context) error
	AfterInstall  func() error
}

type release struct{ Version, URL, Signature string }

type Manager struct {
	options         Options
	mu              sync.Mutex
	operation       sync.Mutex
	view            View
	pending         *release
	listener        func(View)
	client          httpDoer
	now             func() time.Time
	launch          func(string, []string) error
	swap            func(string, string) error
	scheduleChanged chan bool
	runMu           sync.Mutex
}

func New(options Options) *Manager {
	if options.ManifestURL == "" {
		options.ManifestURL = DefaultManifestURL
	}
	if options.PublicKey == "" {
		options.PublicKey = DefaultPublicKey
	}
	if options.Platform == "" {
		if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
			options.Platform = "darwin-aarch64"
		}
		if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
			options.Platform = "windows-x86_64-nsis"
		}
	}
	if options.Executable == "" {
		options.Executable, _ = os.Executable()
	}
	return &Manager{options: options, view: View{Phase: "idle", Current: options.Version},
		client: newHTTPClient(options.ManifestURL), now: time.Now, launch: launchInstaller, swap: swapBundles,
		scheduleChanged: make(chan bool, 1)}
}

// View returns an independent snapshot; callers cannot mutate manager state through pointers.
func (m *Manager) View() View { m.mu.Lock(); defer m.mu.Unlock(); return cloneView(m.view) }

func cloneView(v View) View {
	if v.Version != nil {
		x := *v.Version
		v.Version = &x
	}
	if v.Total != nil {
		x := *v.Total
		v.Total = &x
	}
	if v.Error != nil {
		x := *v.Error
		v.Error = &x
	}
	if v.CheckedAt != nil {
		x := *v.CheckedAt
		v.CheckedAt = &x
	}
	return v
}

// SetListener immediately delivers the current snapshot. Listeners must return promptly.
// Delivery is synchronous, outside the state lock; callbacks may safely call View.
func (m *Manager) SetListener(listener func(View)) {
	m.mu.Lock()
	m.listener = listener
	v := cloneView(m.view)
	m.mu.Unlock()
	if listener != nil {
		listener(v)
	}
}

func (m *Manager) publish(phase string, received uint64, total *uint64, err error) {
	m.mu.Lock()
	v := View{Phase: phase, Current: m.options.Version, Received: received, Total: total, CheckedAt: m.view.CheckedAt}
	if m.pending != nil {
		version := m.pending.Version
		v.Version = &version
	}
	if err != nil {
		text := err.Error()
		v.Error = &text
	}
	m.view = cloneView(v)
	listener := m.listener
	m.mu.Unlock()
	if listener != nil {
		listener(cloneView(v))
	}
}

func normalizedVersion(v string) (string, error) {
	v = strings.TrimPrefix(v, "v")
	// x/mod also accepts abbreviated v1/v1.2; release feeds require full semver.
	if strings.Count(strings.SplitN(strings.SplitN(v, "+", 2)[0], "-", 2)[0], ".") != 2 || !semver.IsValid("v"+v) {
		return "", errors.New("invalid release version")
	}
	return "v" + v, nil
}

func (m *Manager) Check(ctx context.Context) error {
	if !m.operation.TryLock() {
		return ErrBusy
	}
	defer m.operation.Unlock()
	m.publish("checking", 0, nil, nil)
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	update, err := m.fetchRelease(ctx)
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		m.mu.Lock()
		m.pending = update
		now := m.now().UnixMilli()
		checked := uint64(0)
		if now > 0 {
			checked = uint64(now)
		}
		m.view.CheckedAt = &checked
		m.mu.Unlock()
		if update == nil {
			m.publish("current", 0, nil, nil)
		} else {
			m.publish("available", 0, nil, nil)
		}
	} else {
		m.mu.Lock()
		hasPending := m.pending != nil
		m.mu.Unlock()
		phase := "failed"
		if hasPending {
			phase = "available"
		}
		m.publish(phase, 0, nil, err)
	}
	// Last check wins, including manual checks; schedules do not pile up during sleep.
	select {
	case <-m.scheduleChanged:
	default:
	}
	select {
	case m.scheduleChanged <- err == nil:
	default:
	}
	return err
}

func (m *Manager) Install(ctx context.Context) error {
	if !m.operation.TryLock() {
		return ErrBusy
	}
	defer m.operation.Unlock()
	m.mu.Lock()
	pending := m.pending
	m.mu.Unlock()
	if pending == nil {
		return ErrNoUpdate
	}
	m.publish("downloading", 0, nil, nil)
	err := m.install(ctx, *pending)
	if err != nil {
		m.publish("available", 0, nil, err)
	}
	return err
}

func (m *Manager) install(ctx context.Context, update release) error {
	if m.options.Platform != "darwin-aarch64" && m.options.Platform != "windows-x86_64-nsis" {
		return errors.New("unsupported update platform")
	}
	downloadCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	artifact, err := m.download(downloadCtx, update)
	cancel()
	if err != nil {
		return err
	}
	// Windows must retain its private temporary directory after handoff: NSIS opens it
	// asynchronously and may not have opened the file when the desktop exits.
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(artifact.directory)
		}
	}()
	if err = verifyArtifact(ctx, artifact.path, m.options.PublicKey, update.Signature, update.Version); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	m.publish("installing", 0, nil, nil)
	if m.options.Platform == "darwin-aarch64" {
		return m.installMac(ctx, artifact.path)
	}
	if err = validatePE(artifact.path); err != nil {
		return err
	}
	if m.options.BeforeInstall != nil {
		if err = m.options.BeforeInstall(ctx); err != nil {
			return fmt.Errorf("prepare update: %w", err)
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = m.launch(artifact.path, []string{"/UPDATE", "/R"}); err != nil {
		return fmt.Errorf("launch update installer: %w", err)
	}
	keep = true
	m.publish("restarting", 0, nil, nil)
	if m.options.AfterInstall != nil {
		if err = m.options.AfterInstall(); err != nil {
			return fmt.Errorf("installer launched, exit handoff failed: %w", err)
		}
	}
	return nil
}

// Run blocks until cancellation. The host omits it for development builds.
// Only one scheduler runs per manager. Wall-clock comparisons deliberately discard
// monotonic readings so suspended time counts and backwards changes rebase once.
func (m *Manager) Run(ctx context.Context) {
	if !m.runMu.TryLock() {
		return
	}
	defer m.runMu.Unlock()
	next := newSchedule(m.now(), firstCheck, firstJitter, rand.Uint64())
	for {
		wait := next.remaining(m.now())
		if wait > tick {
			wait = tick
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case success := <-m.scheduleChanged:
			timer.Stop()
			next = afterCheck(m.now(), success, rand.Uint64())
		case <-timer.C:
			if next.remaining(m.now()) == 0 {
				err := m.Check(ctx)
				// An install can be busy for minutes. Retry without changing its view.
				if errors.Is(err, ErrBusy) {
					next = newSchedule(m.now(), tick, 0, 0)
				} else {
					next = afterCheck(m.now(), err == nil, rand.Uint64())
				}
			}
		}
	}
}

type schedule struct {
	next  time.Time
	delay time.Duration
}

func newSchedule(now time.Time, base, spread time.Duration, sample uint64) schedule {
	delay := base - spread + time.Duration(sample%uint64(2*spread/time.Millisecond+1))*time.Millisecond
	return schedule{next: now.Round(0).Add(delay), delay: delay}
}
func afterCheck(now time.Time, success bool, sample uint64) schedule {
	if success {
		return newSchedule(now, checkInterval, checkJitter, sample)
	}
	return newSchedule(now, retryInterval, retryJitter, sample)
}
func (s *schedule) remaining(now time.Time) time.Duration {
	now = now.Round(0)
	wait := s.next.Sub(now)
	if wait > s.delay {
		s.next = now.Add(s.delay)
		return s.delay
	}
	if wait < 0 {
		return 0
	}
	return wait
}
func progressStep(received uint64, total *uint64) uint64 {
	if total != nil && *total > 0 {
		if received >= *total {
			return 100
		}
		return received * 100 / *total
	}
	return received >> 20
}
