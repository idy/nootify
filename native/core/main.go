package main

import (
	"bufio"
	"context"
	"encoding/json"
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

func serveStdio(ctx context.Context, c *Core, in io.Reader, out io.Writer) error {
	var writeMu sync.Mutex
	encoder := json.NewEncoder(out)
	write := func(v any) error { writeMu.Lock(); defer writeMu.Unlock(); return encoder.Encode(v) }
	c.emit = func(event string, data any) error { return write(map[string]any{"event": event, "data": data}) }
	if err := write(rpcResponse{ID: 0, Result: map[string]any{"ready": true, "node_id": c.node()}}); err != nil {
		return err
	}
	if err := c.Start(); err != nil {
		c.log("remote_listener_failed", "", "")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	var active atomic.Int32
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64<<10), maxPayload+65536)
	for scanner.Scan() {
		var req rpcRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			_ = write(rpcResponse{ID: 0, Error: &rpcError{"invalid_argument", "invalid request JSON"}})
			continue
		}
		completion := req.Method == "delivery.complete" || req.Method == "dial.complete"
		if !completion && active.Load() >= 128 {
			_ = write(rpcResponse{ID: req.ID, Error: &rpcError{"resource_exhausted", "too many concurrent requests"}})
			continue
		}
		active.Add(1)
		wg.Add(1)
		go func(req rpcRequest) {
			defer wg.Done()
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
		}(req)
	}
	cancel()
	c.Close()
	wg.Wait()
	return scanner.Err()
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
	go func() { <-ctx.Done(); _ = os.Stdin.Close() }()
	core, err := NewCore(ctx, store, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot initialize core state")
		os.Exit(1)
	}
	if err = serveStdio(ctx, core, os.Stdin, protocolOut); err != nil {
		fmt.Fprintln(os.Stderr, "stdio connection closed with an error")
	}
}
