package updater

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const GUIHandoffFlag = "--nootify-update-handoff"
const guiStartupTimeout = 45 * time.Second
const guiShutdownTimeout = 10 * time.Second

type macPending struct {
	root, replacement, staging     string
	original, installed, stageInfo os.FileInfo
	version                        string
}

func executableDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return "", errors.New("invalid GUI executable")
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, io.LimitReader(file, 256<<20+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func sameDirectory(path string, expected os.FileInfo) bool {
	current, err := os.Lstat(path)
	return err == nil && current.IsDir() && current.Mode()&os.ModeSymlink == 0 && os.SameFile(expected, current)
}
func (p *macPending) valid() bool {
	return sameDirectory(p.root, p.installed) && sameDirectory(p.staging, p.stageInfo) && sameDirectory(p.replacement, p.original)
}
func (m *Manager) PendingGUI() bool { return m.guiPending != nil }

// AbortGUI is allowed only before launching any replacement GUI. Cancellation
// returns to the original bundle before the host recovers its prior service state.
func (m *Manager) AbortGUI() error {
	p := m.guiPending
	if p == nil {
		return nil
	}
	if !p.valid() {
		return fmt.Errorf("cancelled GUI handoff identity changed; original retained at %s", p.replacement)
	}
	if m.options.BeforeRollback != nil {
		if err := m.options.BeforeRollback(); err != nil {
			return err
		}
	}
	if err := m.swap(p.replacement, p.root); err != nil {
		return fmt.Errorf("cancelled GUI handoff rollback failed; original retained at %s: %w", p.replacement, err)
	}
	if !sameDirectory(p.root, p.original) || !sameDirectory(p.replacement, p.installed) || !sameDirectory(p.staging, p.stageInfo) {
		return errors.New("cancelled GUI handoff rollback identity changed")
	}
	m.guiPending = nil
	return os.RemoveAll(p.staging)
}

type GUIRelaunchOptions struct {
	SuppressServiceStart bool
	// AfterReady may start the replacement's independent service. GUI readiness
	// is established separately, after a real initialized window and tray.
	AfterReady                      func() error
	RecoverOriginal                 func() error
	Launch                          func(context.Context, string, []string) error
	StartupTimeout, ShutdownTimeout time.Duration
}

// launchGUI uses Launch Services, as MyGo v0.8.3's openBundle does. Unlike
// App.Relaunch, this command's error is retained and readiness is confirmed by IPC.
// A direct GUI child would inherit the old app's macOS process coalition.
func launchGUI(ctx context.Context, executable string, args []string) error {
	root, err := appRoot(executable)
	if err != nil {
		return err
	}
	arguments := append([]string{"-n", root, "--args"}, args...)
	return exec.CommandContext(ctx, "/usr/bin/open", arguments...).Run()
}

// FinishGUI runs after the old MyGo event loop has quit and released its instance
// lock. Only a committed replacement GUI permits deletion of the original bundle.
// No wall-clock cleanup of unconfirmed backups is performed.
func (m *Manager) FinishGUI(ctx context.Context, options GUIRelaunchOptions) (err error) {
	p := m.guiPending
	if p == nil {
		return errors.New("no macOS GUI update is pending")
	}
	if options.Launch == nil {
		options.Launch = launchGUI
	}
	if options.StartupTimeout <= 0 {
		options.StartupTimeout = guiStartupTimeout
	}
	if options.ShutdownTimeout <= 0 {
		options.ShutdownTimeout = guiShutdownTimeout
	}
	if !p.valid() {
		return fmt.Errorf("update handoff identity changed; original retained at %s", p.replacement)
	}
	executable := filepath.Join(p.root, "Contents", "MacOS", "Nootify")
	safe, launchErr := runGUIHandoff(ctx, p.staging, executable, p.version, options, options.AfterReady)
	if launchErr == nil {
		if !p.valid() {
			return fmt.Errorf("GUI relaunched but backup identity changed; original retained at %s", p.replacement)
		}
		// The new process has acknowledged GUI readiness and commit, and is now
		// independently serving its event loop. Cleanup is bounded to this exact stage.
		m.guiPending = nil
		if err := os.RemoveAll(p.staging); err != nil {
			return fmt.Errorf("GUI relaunched; cannot remove confirmed original at %s: %w", p.replacement, err)
		}
		return nil
	}
	if !safe {
		return fmt.Errorf("%w; replacement GUI could not be quiesced; original retained at %s", launchErr, p.replacement)
	}
	if !p.valid() {
		return fmt.Errorf("%w; update identity changed; original retained at %s", launchErr, p.replacement)
	}
	if m.options.BeforeRollback != nil {
		if err := m.options.BeforeRollback(); err != nil {
			return fmt.Errorf("%w; replacement service could not be quiesced; original retained at %s: %v", launchErr, p.replacement, err)
		}
	}
	if err := m.swap(p.replacement, p.root); err != nil {
		return fmt.Errorf("%w; rollback failed; original retained at %s: %v", launchErr, p.replacement, err)
	}
	// After exchange the installed entry must be the saved original. Retain all
	// resources on ambiguity rather than removing another installation's directory.
	if !sameDirectory(p.root, p.original) || !sameDirectory(p.replacement, p.installed) || !sameDirectory(p.staging, p.stageInfo) {
		return fmt.Errorf("%w; rollback identity changed; retained recovery files at %s", launchErr, p.staging)
	}
	m.guiPending = nil
	if options.RecoverOriginal != nil {
		if err := options.RecoverOriginal(); err != nil {
			return fmt.Errorf("%w; original restored but service recovery failed: %v; replacement retained at %s", launchErr, err, p.replacement)
		}
	}
	// Reopen the restored original through the same readiness protocol, carrying
	// the original stopped state. Never use a bare relaunch that loses this policy.
	recovered, recoveryErr := runGUIHandoff(ctx, p.staging, executable, m.options.Version, options, nil)
	if recoveryErr != nil {
		return fmt.Errorf("%w; original restored but GUI recovery failed: %v; recovery files retained at %s", launchErr, recoveryErr, p.staging)
	}
	if recovered && sameDirectory(p.staging, p.stageInfo) && sameDirectory(p.replacement, p.installed) {
		_ = os.RemoveAll(p.staging)
	}
	return fmt.Errorf("%w; original restored and GUI reopened", launchErr)
}

type guiReceipt struct {
	Endpoint             string `json:"endpoint"`
	Token                string `json:"token"`
	Executable           string `json:"executable"`
	Version              string `json:"version"`
	ExecutableSHA256     string `json:"executable_sha256"`
	Expires              int64  `json:"expires"`
	SuppressServiceStart bool   `json:"suppress_service_start"`
}
type guiMessage struct {
	Action string `json:"action"`
	Token  string `json:"token,omitempty"`
}

func writeReceipt(directory, executable, version string, options GUIRelaunchOptions) (guiReceipt, string, net.Listener, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return guiReceipt{}, "", nil, err
	}
	data := make([]byte, 32)
	if _, err = rand.Read(data); err != nil {
		listener.Close()
		return guiReceipt{}, "", nil, err
	}
	digest, err := executableDigest(executable)
	if err != nil {
		listener.Close()
		return guiReceipt{}, "", nil, err
	}
	receipt := guiReceipt{Version: version, ExecutableSHA256: digest, Endpoint: listener.Addr().String(), Token: hex.EncodeToString(data), Executable: executable, Expires: time.Now().Add(options.StartupTimeout + options.ShutdownTimeout + 3*time.Minute).Unix(), SuppressServiceStart: options.SuppressServiceStart}
	file, err := os.CreateTemp(directory, ".gui-handoff-*")
	if err != nil {
		listener.Close()
		return guiReceipt{}, "", nil, err
	}
	path := file.Name()
	err = json.NewEncoder(file).Encode(receipt)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		listener.Close()
		os.Remove(path)
		return guiReceipt{}, "", nil, err
	}
	return receipt, path, listener, nil
}

// safe=true means no replacement was released into its GUI, or it confirmed its
// native loop is stopped. A startup/abort timeout is never evidence of quiescence.
func runGUIHandoff(ctx context.Context, directory, executable, version string, options GUIRelaunchOptions, afterReady func() error) (safe bool, result error) {
	receipt, path, listener, err := writeReceipt(directory, executable, version, options)
	if err != nil {
		return true, err
	}
	defer listener.Close()
	defer os.Remove(path)
	var conn net.Conn
	defer func() {
		if conn != nil {
			conn.Close()
		}
	}()
	// Invalidate the one-use receipt/listener on any launch failure. A late child
	// cannot pass its pre-GUI gate once these resources are gone.
	launchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = options.Launch(launchCtx, executable, []string{GUIHandoffFlag, path})
	cancel()
	if err != nil {
		return true, fmt.Errorf("launch replacement GUI: %w", err)
	}
	if tcp, ok := listener.(*net.TCPListener); ok {
		_ = tcp.SetDeadline(time.Now().Add(options.StartupTimeout))
	}
	conn, err = listener.Accept()
	if err != nil {
		return true, fmt.Errorf("replacement did not enter GUI handoff: %w", err)
	}
	_ = conn.SetWriteDeadline(time.Now().Add(options.StartupTimeout))
	reader := json.NewDecoder(io.LimitReader(bufio.NewReader(conn), 16*1024))
	type incoming struct {
		message guiMessage
		err     error
	}
	messages := make(chan incoming, 8)
	readDone := make(chan struct{})
	defer close(readDone)
	go func() {
		for {
			var message guiMessage
			err := reader.Decode(&message)
			select {
			case messages <- incoming{message, err}:
			case <-readDone:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	receive := func(timeout time.Duration) (guiMessage, error) {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case value := <-messages:
			return value.message, value.err
		case <-timer.C:
			return guiMessage{}, errors.New("GUI handoff timed out")
		}
	}
	writer := json.NewEncoder(conn)
	message, readErr := receive(options.StartupTimeout)
	if readErr != nil || message.Action != "connect" || subtle.ConstantTimeCompare([]byte(message.Token), []byte(receipt.Token)) != 1 {
		return true, errors.New("replacement GUI handoff authentication failed")
	}
	_ = listener.Close()
	_ = os.Remove(path)
	if err = writer.Encode(guiMessage{Action: "start"}); err != nil {
		return false, fmt.Errorf("release replacement GUI: %w", err)
	}
	abort := func(cause error) (bool, error) {
		_ = conn.SetWriteDeadline(time.Now().Add(options.ShutdownTimeout))
		if err := writer.Encode(guiMessage{Action: "abort"}); err != nil {
			return false, cause
		}
		deadline := time.Now().Add(options.ShutdownTimeout)
		for {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return false, cause
			}
			ended, err := receive(remaining)
			if err != nil {
				return false, cause
			}
			if ended.Action == "stopped" {
				return true, cause
			}
		}
	}
	message, err = receive(options.StartupTimeout)
	if err == nil && message.Action == "stopped" {
		return true, errors.New("replacement GUI exited before readiness")
	}
	if err != nil || message.Action != "ready" {
		return abort(errors.New("replacement GUI did not become ready"))
	}
	// The GUI is initialized; the service start is an independent, bounded action.
	// Allow its command deadline without turning successful GUI startup into timeout.
	_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Minute))
	if afterReady != nil {
		if err = afterReady(); err != nil {
			return abort(fmt.Errorf("start replacement service after GUI readiness: %w", err))
		}
	}
	if err = writer.Encode(guiMessage{Action: "commit"}); err != nil {
		return abort(errors.New("replacement GUI commit failed"))
	}
	message, err = receive(options.StartupTimeout)
	if err != nil || message.Action != "committed" {
		return abort(errors.New("replacement GUI did not confirm commit"))
	}
	return true, nil
}

// GUIClient is accepted before native initialization, but never starts the app
// without a live supervising update transaction. It cannot swap/delete bundles.
type GUIClient struct {
	conn      net.Conn
	reader    *json.Decoder
	writer    *json.Encoder
	mu        sync.Mutex
	receipt   guiReceipt
	committed bool
	refused   bool
}

func AcceptGUIHandoff(arguments []string, version, identity string) (*GUIClient, error) {
	path := ""
	for i, arg := range arguments {
		if arg == GUIHandoffFlag {
			if path != "" || i+1 >= len(arguments) {
				return nil, errors.New("invalid GUI update handoff")
			}
			path = arguments[i+1]
		}
	}
	if path == "" {
		return nil, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return acceptGUIHandoff(path, executable, version, identity)
}
func acceptGUIHandoff(path, executable, version, identity string) (*GUIClient, error) {
	if !filepath.IsAbs(path) || !strings.HasPrefix(filepath.Base(path), ".gui-handoff-") {
		return nil, errors.New("invalid GUI handoff receipt")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("GUI handoff receipt is unavailable")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var receipt guiReceipt
	if json.Unmarshal(data, &receipt) != nil || len(receipt.Token) != 64 || receipt.Expires < time.Now().Unix() || receipt.Expires > time.Now().Add(5*time.Minute).Unix() {
		return nil, errors.New("invalid GUI handoff receipt")
	}
	if identity != "dev.idy.nootify" || receipt.Version == "" || receipt.Version != version {
		return nil, errors.New("GUI handoff app identity or version mismatch")
	}
	digest, err := executableDigest(executable)
	if err != nil || digest != receipt.ExecutableSHA256 {
		return nil, errors.New("GUI handoff executable identity mismatch")
	}
	if _, err := appRoot(executable); err != nil {
		return nil, err
	}
	a, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	b, err := filepath.EvalSymlinks(receipt.Executable)
	if err != nil || a != b {
		return nil, errors.New("GUI update handoff is for another executable")
	}
	host, _, err := net.SplitHostPort(receipt.Endpoint)
	if err != nil || host != "127.0.0.1" {
		return nil, errors.New("invalid GUI handoff endpoint")
	}
	conn, err := net.DialTimeout("tcp4", receipt.Endpoint, 5*time.Second)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(guiStartupTimeout))
	client := &GUIClient{conn: conn, reader: json.NewDecoder(io.LimitReader(bufio.NewReader(conn), 16*1024)), writer: json.NewEncoder(conn), receipt: receipt}
	if err = client.writer.Encode(guiMessage{Action: "connect", Token: receipt.Token}); err != nil {
		conn.Close()
		return nil, err
	}
	var message guiMessage
	if err = client.reader.Decode(&message); err != nil || message.Action != "start" {
		conn.Close()
		return nil, errors.New("GUI update was not released for startup")
	}
	_ = conn.SetDeadline(time.Time{})
	return client, nil
}
func (c *GUIClient) SuppressServiceStart() bool { return c != nil && c.receipt.SuppressServiceStart }

// AwaitCommit is started before native initialization. Abort/EOF invokes quit;
// the old process can roll back only after Stopped confirms the native loop ended.
func (c *GUIClient) AwaitCommit(ready <-chan struct{}, committed func(), quit func()) {
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-done:
			return
		case <-ready:
			c.mu.Lock()
			err := c.writer.Encode(guiMessage{Action: "ready"})
			c.mu.Unlock()
			if err != nil {
				quit()
			}
		}
	}()
	for {
		var message guiMessage
		if err := c.reader.Decode(&message); err != nil {
			quit()
			return
		}
		if message.Action == "abort" {
			quit()
			return
		}
		if message.Action == "commit" {
			c.mu.Lock()
			err := c.writer.Encode(guiMessage{Action: "committed"})
			if err == nil {
				c.committed = true
			}
			c.mu.Unlock()
			if err != nil {
				quit()
				return
			}
			committed()
			return
		}
		quit()
		return
	}
}

// Refuse marks an instance-lock collision. Another GUI may still use the new
// bundle, so this child cannot certify resource quiescence for rollback.
func (c *GUIClient) Refuse() {
	if c != nil {
		c.mu.Lock()
		c.refused = true
		c.mu.Unlock()
	}
}
func (c *GUIClient) Stopped() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.committed {
		action := "stopped"
		if c.refused {
			action = "conflict"
		}
		_ = c.writer.Encode(guiMessage{Action: action})
	}
	_ = c.conn.Close()
}
