package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
)

type fakeNode struct {
	start       func() error
	client      localClient
	clientErr   error
	listener    net.Listener
	listenErr   error
	listen      func() (net.Listener, error)
	close       func() error
	started     atomic.Int32
	clientCalls atomic.Int32
	listenCalls atomic.Int32
	closed      atomic.Int32
}

func (n *fakeNode) Start() error {
	n.started.Add(1)
	if n.start != nil {
		return n.start()
	}
	return nil
}
func (n *fakeNode) Client() (localClient, error) {
	n.clientCalls.Add(1)
	return n.client, n.clientErr
}
func (n *fakeNode) Listen() (net.Listener, error) {
	n.listenCalls.Add(1)
	if n.listen != nil {
		return n.listen()
	}
	return n.listener, n.listenErr
}
func (n *fakeNode) Close() error {
	n.closed.Add(1)
	if n.close != nil {
		return n.close()
	}
	return nil
}

type observedInput struct {
	io.ReadCloser
	closed chan struct{}
	once   sync.Once
}

func (r *observedInput) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(func() { close(r.closed) })
	return err
}

type serviceHarness struct {
	*rpcHarness
	stdinClosed <-chan struct{}
}

func startTestService(t *testing.T, cfg config, node embeddedNode) *serviceHarness {
	t.Helper()
	if cfg.stateDir == "" {
		cfg.stateDir = filepath.Join(t.TempDir(), "state")
	}
	stdin, input := io.Pipe()
	output, stdout := io.Pipe()
	reader := &observedInput{ReadCloser: stdin, closed: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	h := &serviceHarness{
		rpcHarness:  &rpcHarness{input: input, output: bufio.NewReader(output), reader: output, cancel: cancel, done: make(chan struct{})},
		stdinClosed: reader.closed,
	}
	go func() {
		h.err = runService(ctx, cfg, reader, stdout, node)
		close(h.done)
	}()
	t.Cleanup(func() { cancel(); input.Close(); output.Close(); await(t, h.done) })
	return h
}

func (h *serviceHarness) ready(t *testing.T) {
	t.Helper()
	reply := h.read(t)
	result, ok := reply.Result.(map[string]any)
	if reply.ID != 0 || reply.Error != "" || !ok || len(result) != 1 || result["ready"] != true {
		t.Fatalf("incorrect readiness frame: %#v", reply)
	}
}

func TestServiceReadyAfterStartClientAndListenWithoutAuthentication(t *testing.T) {
	listening := make(chan struct{})
	release := make(chan struct{})
	releaseListen := sync.OnceFunc(func() { close(release) })
	listener := newTestListener()
	var statusCalls atomic.Int32
	node := &fakeNode{
		client: fakeClient{status: func(context.Context) (*ipnstate.Status, error) {
			statusCalls.Add(1)
			return &ipnstate.Status{BackendState: "NeedsLogin"}, nil
		}},
		listen: func() (net.Listener, error) { close(listening); <-release; return listener, nil },
	}
	h := startTestService(t, config{}, node)
	t.Cleanup(releaseListen)
	await(t, listening)
	// The RPC reader stays active while initialization is blocked, but the
	// request cannot run until the readiness frame has been written.
	h.send(t, "{\"id\":1,\"method\":\"status\"}\n")
	if node.started.Load() != 1 || node.clientCalls.Load() != 1 || statusCalls.Load() != 0 {
		t.Fatal("startup skipped a phase or dispatched RPC before readiness")
	}
	releaseListen()
	h.ready(t)
	if node.listenCalls.Load() != 1 || statusCalls.Load() > 1 {
		t.Fatal("unexpected initialization calls")
	}
	if reply := h.read(t); reply.ID != 1 || reply.Error != "" || reply.Result.(map[string]any)["BackendState"] != "NeedsLogin" {
		t.Fatalf("ready must not require login: %#v", reply)
	}
	h.input.Close()
	await(t, h.done)
	if h.err != nil || node.closed.Load() != 1 {
		t.Fatalf("shutdown: %v, close=%d", h.err, node.closed.Load())
	}
}

func TestServiceParentExitClosesNodeAndForwardedSockets(t *testing.T) {
	for _, reason := range []string{"stdin-eof", "signal-context"} {
		t.Run(reason, func(t *testing.T) {
			backend := backendListener(t)
			listener := newTestListener()
			var loginCalls atomic.Int32
			node := &fakeNode{listener: listener, client: fakeClient{login: func(context.Context) error { loginCalls.Add(1); return nil }}}
			h := startTestService(t, config{target: backend.Addr().String()}, node)
			h.ready(t)
			await(t, listener.accepting)
			peerClient, peer := tcpPair(t)
			sendPeer(t, listener, peer)
			server := acceptBackend(t, backend)
			if _, err := bufio.NewReader(server).ReadString('\n'); err != nil {
				t.Fatal(err)
			}
			h.send(t, "{\"id\":1,\"method\":\"status\"}\n")
			reply := h.read(t)
			status, ok := reply.Result.(map[string]any)
			if reply.ID != 1 || !ok || status["BackendState"] != "NeedsLogin" || status["NootifyListening"] != true {
				t.Fatalf("incorrect startup status: %#v", reply)
			}
			if reason == "stdin-eof" {
				h.input.Close()
			} else {
				h.cancel()
			}
			await(t, h.done)
			if h.err != nil || node.started.Load() != 1 || node.closed.Load() != 1 || loginCalls.Load() != 0 {
				t.Fatalf("shutdown: err=%v start=%d close=%d login=%d", h.err, node.started.Load(), node.closed.Load(), loginCalls.Load())
			}
			await(t, listener.closed)
			for _, conn := range []net.Conn{peerClient, server} {
				_, err := conn.Read(make([]byte, 1))
				if err == nil {
					t.Fatal("socket still open after service exited")
				}
				var netErr net.Error
				if errors.As(err, &netErr) && netErr.Timeout() {
					t.Fatal("socket only closed by test deadline")
				}
			}
		})
	}
}

func TestServiceDoesNotCloseConcurrentlyWithStart(t *testing.T) {
	for _, reason := range []string{"stdin-eof", "signal-context"} {
		t.Run(reason, func(t *testing.T) {
			entered := make(chan struct{})
			release := make(chan struct{})
			releaseStart := sync.OnceFunc(func() { close(release) })
			node := &fakeNode{
				start:  func() error { close(entered); <-release; return nil },
				client: fakeClient{}, listener: newTestListener(),
			}
			h := startTestService(t, config{}, node)
			t.Cleanup(releaseStart)
			await(t, entered)
			if reason == "stdin-eof" {
				h.input.Close()
			} else {
				h.cancel()
			}
			await(t, h.stdinClosed)
			if node.closed.Load() != 0 {
				t.Fatal("closed node during Start")
			}
			releaseStart()
			await(t, h.done)
			if h.err != nil || node.closed.Load() != 1 || node.clientCalls.Load() != 0 || node.listenCalls.Load() != 0 {
				t.Fatalf("canceled startup continued or leaked: %v, close=%d", h.err, node.closed.Load())
			}
			if data, err := io.ReadAll(h.output); err != nil || len(data) != 0 {
				t.Fatalf("sent readiness after parent exit: %q, %v", data, err)
			}
		})
	}
}

func TestServiceStartupErrorsAreSafeAndFlushed(t *testing.T) {
	for _, name := range []string{"state_unavailable", "state_locked", "startup_failed", "client_unavailable", "nil_client", "listener_failed", "nil_listener"} {
		t.Run(name, func(t *testing.T) {
			cfg := config{stateDir: filepath.Join(t.TempDir(), "state")}
			node := &fakeNode{client: fakeClient{}, listener: newTestListener()}
			secret := errors.New("https://login.tailscale.com/a/must-not-leak")
			code := name
			switch name {
			case "state_unavailable":
				if err := os.WriteFile(cfg.stateDir, []byte("not-a-directory"), 0600); err != nil {
					t.Fatal(err)
				}
			case "state_locked":
				lock, err := prepareStateDir(cfg.stateDir)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.Close()
			case "startup_failed":
				node.start = func() error { return secret }
			case "client_unavailable":
				node.clientErr = secret
			case "nil_client":
				node.client = nil
				code = "client_unavailable"
			case "listener_failed":
				node.listenErr = secret
			case "nil_listener":
				node.listener = nil
				code = "listener_failed"
			}
			stdin, input := io.Pipe()
			defer input.Close()
			var stdout writeBuffer
			err := runService(context.Background(), cfg, stdin, &stdout, node)
			want := fmt.Sprintf("{\"id\":0,\"error\":%q}\n", code)
			if err == nil || err.Error() != code || stdout.String() != want || strings.Contains(stdout.String(), "must-not-leak") {
				t.Fatalf("unsafe/lost startup error: %v, %q", err, stdout.String())
			}
			if strings.HasPrefix(name, "state_") {
				if node.started.Load() != 0 || node.closed.Load() != 0 {
					t.Fatal("touched tsnet without available state")
				}
			} else if node.started.Load() != 1 || node.closed.Load() != 1 {
				t.Fatal("node leaked after initialization failure")
			}
		})
	}
}

func TestServiceFailureFramePrecedesNodeClose(t *testing.T) {
	closing := make(chan struct{})
	release := make(chan struct{})
	releaseClose := sync.OnceFunc(func() { close(release) })
	node := &fakeNode{
		clientErr: errors.New("private-startup-error"),
		close:     func() error { close(closing); <-release; return nil },
	}
	h := startTestService(t, config{}, node)
	t.Cleanup(releaseClose)
	if reply := h.read(t); reply.ID != 0 || reply.Error != "client_unavailable" || reply.Result != nil {
		t.Fatalf("missing failure frame before cleanup: %#v", reply)
	}
	await(t, closing)
	select {
	case <-h.done:
		t.Fatal("service did not wait for Close")
	default:
	}
	releaseClose()
	await(t, h.done)
	if h.err == nil || h.err.Error() != "client_unavailable" {
		t.Fatal(h.err)
	}
}

func TestServiceHoldsStateLockBeforeStartThroughClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state")
	startLock := make(chan error, 1)
	closing := make(chan struct{})
	release := make(chan struct{})
	releaseClose := sync.OnceFunc(func() { close(release) })
	node := &fakeNode{
		client: fakeClient{}, listener: newTestListener(),
		start: func() error {
			lock, err := prepareStateDir(path)
			if lock != nil {
				lock.Close()
			}
			startLock <- err
			return nil
		},
		close: func() error { close(closing); <-release; return nil },
	}
	h := startTestService(t, config{stateDir: path}, node)
	t.Cleanup(releaseClose)
	h.ready(t)
	if err := <-startLock; !errors.Is(err, errStateLocked) {
		t.Fatalf("state not locked before Start: %v", err)
	}
	h.cancel()
	await(t, closing)
	if lock, err := prepareStateDir(path); !errors.Is(err, errStateLocked) {
		if lock != nil {
			lock.Close()
		}
		t.Fatalf("state unlocked before Close returned: %v", err)
	}
	releaseClose()
	await(t, h.done)
	lock, err := prepareStateDir(path)
	if err != nil {
		t.Fatalf("state lock not released after Close: %v", err)
	}
	lock.Close()
}

func TestServiceIdleProcessStdinShutdown(t *testing.T) {
	if os.Getenv("NOOTIFY_TEST_STDIO_CHILD") == "1" {
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
		defer stop()
		node := &fakeNode{client: fakeClient{}, listener: newTestListener()}
		stdin, err := openProcessStdin()
		if err != nil {
			t.Fatal(err)
		}
		if err := runService(ctx, config{stateDir: os.Getenv("NOOTIFY_TEST_STATE_DIR")}, stdin, os.Stdout, node); err != nil {
			t.Fatal(err)
		}
		return
	}
	for _, reason := range []string{"stdin-eof", "sigterm"} {
		t.Run(reason, func(t *testing.T) {
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, executable, "-test.run=^TestServiceIdleProcessStdinShutdown$")
			cmd.Env = append(os.Environ(), "NOOTIFY_TEST_STDIO_CHILD=1", "NOOTIFY_TEST_STATE_DIR="+filepath.Join(t.TempDir(), "state"))
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			var processErr error
			go func() { processErr = cmd.Wait(); close(done) }()
			t.Cleanup(func() { stdin.Close(); cmd.Process.Kill(); await(t, done) })
			h := &serviceHarness{rpcHarness: &rpcHarness{output: bufio.NewReader(stdout), cancel: func() { cmd.Process.Kill() }}}
			h.ready(t)
			if reason == "stdin-eof" {
				stdin.Close()
			} else if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			// For SIGTERM, keep the parent's writer open to exercise the idle read.
			select {
			case <-done:
				if processErr != nil {
					t.Fatal(processErr)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("process did not exit on %s", reason)
			}
		})
	}
}

func TestServiceRuntimeListenerFailureReachesParent(t *testing.T) {
	for _, cause := range []error{errors.New("private-listener-error"), net.ErrClosed} {
		t.Run(cause.Error(), func(t *testing.T) {
			listener := newTestListener()
			node := &fakeNode{client: fakeClient{}, listener: listener}
			h := startTestService(t, config{}, node)
			h.ready(t)
			await(t, listener.accepting)
			h.send(t, "{\"id\":1,\"method\":\"status\"}\n")
			if reply := h.read(t); reply.ID != 1 || reply.Error != "" {
				t.Fatal(reply)
			}
			listener.fail <- cause
			if reply := h.read(t); reply.ID != 0 || reply.Error != "listener_failed" || reply.Result != nil {
				t.Fatalf("missing runtime listener failure: %#v", reply)
			}
			await(t, h.done)
			if h.err == nil || h.err.Error() != "listener_failed" || node.closed.Load() != 1 {
				t.Fatalf("listener failure cleanup: %v, close=%d", h.err, node.closed.Load())
			}
		})
	}
}
