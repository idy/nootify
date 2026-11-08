package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

func (c *Core) Handle(ctx context.Context, method string, raw json.RawMessage, local bool) (any, error) {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if len(raw) > maxPayload || !strings.HasPrefix(strings.TrimSpace(string(raw)), "{") {
		return nil, fault("invalid_argument", "params must be an object")
	}
	var p struct {
		ProviderID string         `json:"provider_id"`
		ID         string         `json:"id"`
		Session    Session        `json:"session"`
		Metadata   map[string]any `json:"metadata"`
		Content    Content        `json:"content"`
		RequestID  string         `json:"request_id"`
		Message    *MessageRef    `json:"message"`
		MessageID  string         `json:"message_id"`
		DeliveryID string         `json:"delivery_id"`
		Status     string         `json:"status"`
		Transport  string         `json:"transport_status"`
		Error      string         `json:"error"`
		Address    string         `json:"address"`
		Tailnet    bool           `json:"tailnet_enabled"`
		Automatic  bool           `json:"automatic"`
		ChatID     string         `json:"chat_id"`
		SenderID   string         `json:"sender_open_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fault("invalid_argument", "invalid params")
	}
	if !local {
		switch method {
		case "session.ensure", "session.bind", "session.metadata.get", "session.metadata.set", "session.delete", "message.send", "message.reply", "message.ack":
		default:
			return nil, fault("permission_denied", "method is private to the local bridge")
		}
		if strings.HasPrefix(method, "session.") || method == "message.send" {
			if p.Session.NodeID == "" {
				return nil, fault("invalid_argument", "remote commands must preserve the session node identity")
			}
		}
	}
	switch method {
	case "status":
		return c.Status(), nil
	case "provider.save":
		return c.SaveProvider(raw)
	case "provider.delete":
		return map[string]any{"deleted": true}, c.DeleteProvider(p.ID)
	case "provider.default":
		err := c.store.Update(func(d *State) error {
			if _, ok := d.Providers[p.ID]; !ok {
				return fault("not_found", "provider does not exist")
			}
			d.DefaultProvider = p.ID
			return nil
		})
		return map[string]any{"default_provider_id": p.ID}, err
	case "remote.configure":
		return c.ConfigureRemote(raw)
	case "remote.secret":
		return map[string]any{"token": c.store.Snapshot().Remote.Token}, nil
	case "session.ensure":
		ctx = context.WithValue(ctx, automaticKey{}, p.Automatic)
		return c.Ensure(ctx, p.ProviderID, p.Session)
	case "session.bind":
		return c.Bind(ctx, p.ProviderID, p.Session, p.ChatID, p.SenderID)
	case "session.list":
		bindings := []Binding{}
		for _, b := range c.store.Snapshot().Bindings {
			if p.ProviderID == "" || b.ProviderID == p.ProviderID {
				bindings = append(bindings, b)
			}
		}
		return bindings, nil
	case "session.metadata.get":
		return c.GetMetadata(ctx, p.ProviderID, p.Session)
	case "session.metadata.set":
		return c.SetMetadata(ctx, p.ProviderID, p.Session, p.Metadata)
	case "session.delete":
		return map[string]any{"deleted": true}, c.Delete(ctx, p.ProviderID, p.Session)
	case "message.send":
		return c.Send(ctx, p.ProviderID, p.Session, p.Content, p.RequestID)
	case "message.reply":
		m, err := c.Resolve(p.Message, p.MessageID)
		if err != nil {
			return nil, err
		}
		return c.Reply(ctx, m, p.Content, p.RequestID)
	case "message.ack":
		m, err := c.Resolve(p.Message, p.MessageID)
		if err != nil {
			return nil, err
		}
		return c.Ack(ctx, m)
	case "delivery.complete":
		return map[string]any{"completed": true}, c.Complete(p.DeliveryID, p.Status, p.Transport, p.Error)
	case "delivery.retry":
		return map[string]any{"retried": true}, c.RetryDelivery(p.DeliveryID)
	case "dial.complete":
		return map[string]any{"completed": true}, c.completeDial(p.RequestID, p.Address, p.Error)
	case "transport.configure":
		c.ops.Lock()
		defer c.ops.Unlock()
		before := c.store.Snapshot().Tailnet
		err := c.store.Update(func(d *State) error { d.Tailnet = p.Tailnet; return nil })
		if err == nil && before != p.Tailnet {
			for _, cfg := range c.store.Snapshot().Providers {
				if cfg.Type == "remote" {
					c.startProvider(cfg)
				}
			}
		}
		return map[string]any{"tailnet_enabled": p.Tailnet}, err
	case "migration.import":
		return c.Migrate(raw)
	case "config.export":
		return c.ExportConfig(), nil
	case "config.import":
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(raw, &fields)
		doc := raw
		if b, ok := fields["config"]; ok {
			doc = b
		}
		err := c.ImportConfig(doc)
		return map[string]any{"imported": true}, err
	default:
		return nil, fault("method_not_found", "unknown method")
	}
}

type rpcRequest struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type rpcResponse struct {
	ID     int64     `json:"id"`
	Result any       `json:"result,omitempty"`
	Error  *rpcError `json:"error,omitempty"`
}

// stdioFile owns a pipe/socket descriptor. Inherited Unix stdio descriptors may
// be blocking and unpollable: Close alone cannot interrupt a blocked syscall.
// Put them in nonblocking mode without calling Fd (which disables Go deadlines).
// Go's Windows pipe Close also cancels synchronous I/O via CancelIoEx.
// The retry path is only used when the descriptor lacks runtime poller support.
type stdioFile struct {
	*os.File
	ctx context.Context
}

func setStdioNonblock[T ~int | ~uintptr](fd uintptr, set func(T, bool) error) error {
	return set(T(fd), true)
}

func ownStdioFile(ctx context.Context, f *os.File) (*stdioFile, error) {
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return nil, fmt.Errorf("stdio requires a pipe or socket")
	}
	raw, err := f.SyscallConn()
	if err != nil {
		return nil, err
	}
	var nonblockErr error
	if err = raw.Control(func(fd uintptr) {
		nonblockErr = setStdioNonblock(fd, syscall.SetNonblock)
	}); err != nil {
		return nil, err
	}
	if nonblockErr != nil {
		return nil, nonblockErr
	}
	return &stdioFile{File: f, ctx: ctx}, nil
}

func (f *stdioFile) retry() error {
	timer := time.NewTimer(20 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-f.ctx.Done():
		return context.Cause(f.ctx)
	case <-timer.C:
		return nil
	}
}

func (f *stdioFile) Read(p []byte) (int, error) {
	for {
		if err := f.ctx.Err(); err != nil {
			return 0, context.Cause(f.ctx)
		}
		n, err := f.File.Read(p)
		if n > 0 || !errors.Is(err, syscall.EAGAIN) {
			return n, err
		}
		if err = f.retry(); err != nil {
			return 0, err
		}
	}
}

func (f *stdioFile) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		if err := f.ctx.Err(); err != nil {
			return written, context.Cause(f.ctx)
		}
		n, err := f.File.Write(p)
		written += n
		p = p[n:]
		if err != nil {
			if !errors.Is(err, syscall.EAGAIN) {
				return written, err
			}
			if err = f.retry(); err != nil {
				return written, err
			}
		} else if n == 0 {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

const stdioOutputBuffer = 16

// newStdioOutput uses one encoder and a bounded queue, never one goroutine per
// write. Canceling ctx wakes every caller, including those waiting to enqueue.
// The owner must interrupt the underlying writer on cancellation and join run.
func newStdioOutput(ctx context.Context, out io.Writer, cancel context.CancelCauseFunc) (write func(any) error, run func()) {
	type pendingWrite struct {
		value any
		done  chan error
	}
	queue := make(chan pendingWrite, stdioOutputBuffer)
	write = func(value any) error {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		pending := pendingWrite{value: value, done: make(chan error, 1)}
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case queue <- pending:
		}
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case err := <-pending.done:
			return err
		}
	}
	run = func() {
		encoder := json.NewEncoder(out)
		for {
			select {
			case <-ctx.Done():
				return
			case pending := <-queue:
				if ctx.Err() != nil {
					return
				}
				err := encoder.Encode(pending.value)
				if err != nil {
					cancel(err)
				}
				pending.done <- err
				if err != nil {
					return
				}
			}
		}
	}
	return write, run
}

// serveStdio takes ownership of closable input/output. Their Close methods must
// promptly interrupt ongoing Read/Write calls and reject future calls (io.Pipe
// satisfies this contract). OS pipes/sockets are adapted above; finite in-memory
// readers and *bytes.Buffer output need no interruption. Arbitrary blocking
// io.Writer/io.Reader implementations cannot be canceled and are rejected.
func serveStdio(parent context.Context, c *Core, in io.Reader, out io.Writer) error {
	ctx, cancel := context.WithCancelCause(parent)
	var ioWG, requestWG sync.WaitGroup
	defer func() {
		cancel(io.EOF)
		c.Close()
		requestWG.Wait()
		ioWG.Wait()
	}()
	if f, ok := in.(*os.File); ok {
		adapted, err := ownStdioFile(ctx, f)
		if err != nil {
			return err
		}
		in = adapted
	}
	if f, ok := out.(*os.File); ok {
		adapted, err := ownStdioFile(ctx, f)
		if err != nil {
			return err
		}
		out = adapted
	}
	inputCloser, inputClosable := in.(io.Closer)
	if !inputClosable {
		switch in.(type) {
		case *bytes.Buffer, *bytes.Reader, *strings.Reader:
		default:
			return fmt.Errorf("stdio input must support interruptible Close")
		}
	}
	outputCloser, outputClosable := out.(io.Closer)
	if !outputClosable {
		if _, ok := out.(*bytes.Buffer); !ok {
			return fmt.Errorf("stdio output must support interruptible Close")
		}
	}
	ioWG.Add(1)
	go func() {
		defer ioWG.Done()
		<-ctx.Done()
		if outputClosable {
			_ = outputCloser.Close()
		}
		if inputClosable {
			_ = inputCloser.Close()
		}
	}()
	write, runOutput := newStdioOutput(ctx, out, cancel)
	ioWG.Add(1)
	go func() { defer ioWG.Done(); runOutput() }()
	c.emit = func(event string, data any) error { return write(map[string]any{"event": event, "data": data}) }

	type scannedRequest struct {
		rpcRequest
		invalid bool
	}
	requests := make(chan scannedRequest, 128)
	ioWG.Add(1)
	go func() {
		defer ioWG.Done()
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 64<<10), maxPayload+65536)
		for scanner.Scan() {
			var req scannedRequest
			req.invalid = json.Unmarshal(scanner.Bytes(), &req.rpcRequest) != nil
			select {
			case <-ctx.Done():
				return
			case requests <- req:
			default:
				// Bound pre-ready input too, so an undrained handshake cannot
				// hide EOF behind an unlimited queue of pipelined requests.
				cancel(fault("resource_exhausted", "too many pending requests"))
				return
			}
		}
		if err := scanner.Err(); err != nil {
			cancel(err)
		} else {
			cancel(io.EOF)
		}
	}()
	result := func() error {
		if errors.Is(context.Cause(ctx), io.EOF) {
			return nil
		}
		return context.Cause(ctx)
	}
	if err := write(rpcResponse{ID: 0, Result: map[string]any{"ready": true, "node_id": c.node()}}); err != nil {
		return result()
	}
	if err := c.Start(); err != nil {
		c.log("remote_listener_failed", "", "")
	}
	var active atomic.Int32
	for {
		var req scannedRequest
		select {
		case <-ctx.Done():
			return result()
		case req = <-requests:
		}
		if req.invalid {
			_ = write(rpcResponse{ID: 0, Error: &rpcError{"invalid_argument", "invalid request JSON"}})
			continue
		}
		completion := req.Method == "delivery.complete" || req.Method == "dial.complete"
		if !completion && active.Load() >= 128 {
			_ = write(rpcResponse{ID: req.ID, Error: &rpcError{"resource_exhausted", "too many concurrent requests"}})
			continue
		}
		active.Add(1)
		requestWG.Add(1)
		go func(req rpcRequest) {
			defer requestWG.Done()
			defer active.Add(-1)
			rctx, stop := context.WithTimeout(ctx, 60*time.Second)
			defer stop()
			defer func() {
				if recover() != nil {
					_ = write(rpcResponse{ID: req.ID, Error: &rpcError{"internal", "operation failed"}})
				}
			}()
			result, err := c.Handle(rctx, req.Method, req.Params, true)
			response := rpcResponse{ID: req.ID, Result: result}
			if err != nil {
				response.Result = nil
				response.Error = publicError(err)
			}
			_ = write(response)
		}(req.rpcRequest)
	}
}
func main() {
	// The SDK's dispatcher constructor logs once before a custom logger can be
	// installed. Keep all library writes away from the protocol descriptor.
	protocolOut := os.Stdout
	os.Stdout = os.Stderr
	stateDir := flag.String("state-dir", "", "private state directory")
	version := flag.Bool("version", false, "print protocol version")
	flag.Parse()
	if *version {
		fmt.Fprintln(protocolOut, "nootify-core 1")
		return
	}
	if *stateDir == "" {
		fmt.Fprintln(os.Stderr, "--state-dir is required")
		os.Exit(2)
	}
	store, err := OpenStore(*stateDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot open private core state")
		os.Exit(1)
	}
	defer store.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	core, err := NewCore(ctx, store, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot initialize core state")
		os.Exit(1)
	}
	if err = serveStdio(ctx, core, os.Stdin, protocolOut); err != nil {
		fmt.Fprintln(os.Stderr, "stdio connection closed with an error")
	}
}
