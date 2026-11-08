// nootify-tsnet owns Nootify's embedded Tailscale node. Its only control channel
// is private newline-delimited JSON on stdin/stdout; it never uses a host daemon.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/tsnet"
)

// Populated from the resolved module pin by scripts/build-tsnet.mjs.
var tailscaleVersion = "development"

func helperVersion() string { return "nootify-tsnet " + strings.TrimPrefix(tailscaleVersion, "v") }

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.ReadCloser, stdout io.WriteCloser, stderr io.Writer) int {
	cfg, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, "nootify-tsnet: invalid_arguments")
		return 2
	}
	if cfg.version {
		if _, err := fmt.Fprintln(stdout, helperVersion()); err != nil {
			return 1
		}
		return 0
	}

	if stdin == os.Stdin {
		stdin, err = openProcessStdin()
		if err != nil {
			_ = (&protocolOutput{WriteCloser: stdout}).emit(failure(0, "startup_failed"))
			fmt.Fprintln(stderr, "nootify-tsnet: startup_failed")
			return 1
		}
	}

	prepareProcess()
	privateEnvironment()
	log.SetOutput(io.Discard)
	// tsnet sends its own user messages to logtail as well as UserLogf. Disable
	// buffering/uploading, not just stderr, so login URLs stay in private RPC.
	logtail.Disable()
	envknob.SetNoLogsNoSupport()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	node := &tsnetNode{server: &tsnet.Server{
		Dir:      cfg.stateDir,
		Hostname: cfg.hostname,
		UserLogf: func(string, ...any) {},
		Logf:     func(string, ...any) {},
		// AuthKey, OAuth/WIF credentials, Tun, and RunWebClient stay unset.
		// tsnet supplies the default Tailscale control plane and user-space stack.
	}}
	if err := runService(ctx, cfg, stdin, stdout, node); err != nil {
		// Only our fixed codes reach stderr; backend errors may contain secrets.
		fmt.Fprintln(stderr, "nootify-tsnet:", err)
		return 1
	}
	return 0
}

// Clear both environment variables and envknob's initialization-time caches.
// The parent also uses an environment allowlist. Keeping this here prevents
// auth keys, OAuth/WIF, alternate control servers, and forced login on direct use.
func privateEnvironment() {
	privateEnvironmentForOS(runtime.GOOS)
}

func privateEnvironmentForOS(goos string) {
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		canonical := name
		if goos == "windows" {
			canonical = strings.ToUpper(name)
		}
		if strings.HasPrefix(canonical, "TS_") || strings.HasPrefix(canonical, "TSNET_") || strings.HasPrefix(canonical, "TAILSCALE_") {
			// Windows looks up environment names without case, but envknob caches
			// are keyed by exact spelling. Invalidate both before removing the value.
			envknob.Setenv(name, "")
			if canonical != name {
				envknob.Setenv(canonical, "")
				os.Unsetenv(canonical)
			}
			os.Unsetenv(name)
		}
	}
}

type embeddedNode interface {
	Start() error
	Client() (localClient, error)
	Listen() (net.Listener, error)
	Dial(context.Context, string, string) (net.Conn, error)
	ListenPort(int) (net.Listener, error)
	Close() error
}

type tsnetNode struct{ server *tsnet.Server }

func (n *tsnetNode) Start() error                  { return n.server.Start() }
func (n *tsnetNode) Client() (localClient, error)  { return n.server.LocalClient() }
func (n *tsnetNode) Listen() (net.Listener, error) { return n.ListenPort(80) }
func (n *tsnetNode) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	return n.server.Dial(ctx, network, address)
}
func (n *tsnetNode) ListenPort(port int) (net.Listener, error) {
	return n.server.Listen("tcp", ":"+strconv.Itoa(port))
}
func (n *tsnetNode) Close() error { return n.server.Close() }

// Propagate RPC stream shutdown to startup before closing the underlying input.
// serveRPC owns a child context; waiting for it to return leaves a window where
// Start can finish after EOF while the service context still looks live.
type cancelingInput struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (input cancelingInput) Close() error {
	input.cancel()
	return input.ReadCloser.Close()
}

func runService(parent context.Context, cfg config, stdin io.ReadCloser, stdout io.WriteCloser, node embeddedNode) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	output := &protocolOutput{WriteCloser: stdout}
	fail := func(code string) error {
		// Write synchronously before cancellation closes stdout. Only fixed codes
		// cross the protocol; upstream errors can contain credentials/login URLs.
		_ = output.emit(failure(0, code))
		return errors.New(code)
	}

	// Read stdin even during startup. EOF cancels pending RPCs immediately;
	// tsnet.Close must only run after Start returns (the upstream API contract).
	ready := make(chan struct{})
	var dispatcher *rpcDispatcher
	var rpcErr error
	rpcDone := make(chan struct{})
	go func() {
		rpcErr = serveRPC(ctx, cancelingInput{ReadCloser: stdin, cancel: cancel}, output, func(ctx context.Context, req request) response {
			select {
			case <-ready:
				return dispatcher.dispatch(ctx, req)
			case <-ctx.Done():
				return failure(req.ID, contextError(ctx.Err(), "unavailable"))
			}
		})
		cancel()
		close(rpcDone)
	}()
	defer func() { cancel(); <-rpcDone }()

	lock, err := prepareStateDir(cfg.stateDir)
	if err != nil {
		if errors.Is(err, errStateLocked) {
			return fail("state_locked")
		}
		return fail("state_unavailable")
	}
	defer lock.Close()
	if ctx.Err() != nil {
		return nil
	}
	// Even a failed Start can allocate resources. This defer runs after Start
	// returns and before lock.Close, including on all initialization failures.
	defer func() { cancel(); node.Close() }()
	if err := node.Start(); err != nil {
		return fail("startup_failed")
	}
	if ctx.Err() != nil {
		return nil
	}
	client, err := node.Client()
	if err != nil || client == nil {
		return fail("client_unavailable")
	}
	listener, err := node.Listen()
	if err != nil || listener == nil {
		return fail("listener_failed")
	}

	forwarder := newForwarder(listener, cfg.target)
	transport := newTCPTransport(ctx, node.Dial, node.ListenPort)
	defer transport.close()
	dispatcher = &rpcDispatcher{
		client:    client,
		listening: forwarder.listening.Load,
		mutations: make(chan struct{}, 1),
		transport: transport,
	}
	// Readiness means the embedded stack, LocalAPI, and port 80 listener exist;
	// it deliberately does not wait for authentication or an assigned address.
	if err := output.emit(response{ID: 0, Result: struct {
		Ready bool `json:"ready"`
	}{true}}); err != nil {
		forwarder.close()
		return errors.New("rpc_output_failed")
	}
	var forwardErr error
	forwardDone := make(chan struct{})
	go func() {
		forwardErr = forwarder.serve(ctx)
		if forwardErr != nil {
			_ = output.emit(failure(0, "listener_failed"))
		}
		cancel()
		close(forwardDone)
	}()
	defer func() { cancel(); forwarder.close(); <-forwardDone }()
	close(ready)

	<-ctx.Done()
	<-forwardDone
	<-rpcDone
	if forwardErr != nil {
		return errors.New("listener_failed")
	}
	return rpcErr
}
