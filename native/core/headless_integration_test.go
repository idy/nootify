package core

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc/metadata"
)

const headlessUpstreamStateEnv = "NOOTIFY_HEADLESS_UPSTREAM_STATE_DIR"
const headlessFixtureBotID = "fixture-bot"

// This wrapper mocks only the external bot boundary. Session mappings, RPCs,
// routing, subscriptions, confirmations, refs and persistence remain production
// Core behavior. The shared lock makes counters and their last text coherent.
type headlessFixtureBot struct {
	*fakeProvider
	textMu        sync.Mutex
	lastSendText  string
	lastReplyText string
}

func (b *headlessFixtureBot) Send(ctx context.Context, binding Binding, content Content, request string) (SendResult, error) {
	b.textMu.Lock()
	defer b.textMu.Unlock()
	result, err := b.fakeProvider.Send(ctx, binding, content, request)
	if err == nil {
		b.lastSendText = content.Plain()
	}
	return result, err
}
func (b *headlessFixtureBot) Reply(ctx context.Context, message MessageRef, content Content, request string) (SendResult, error) {
	b.textMu.Lock()
	defer b.textMu.Unlock()
	result, err := b.fakeProvider.Reply(ctx, message, content, request)
	if err == nil {
		b.lastReplyText = content.Plain()
	}
	return result, err
}

type headlessBotSummary struct {
	Ensures       int        `json:"ensures"`
	Sends         int        `json:"sends"`
	Replies       int        `json:"replies"`
	Acks          int        `json:"acks"`
	Deletes       int        `json:"deletes"`
	LastAck       MessageRef `json:"last_ack"`
	LastReply     MessageRef `json:"last_reply"`
	LastSendText  string     `json:"last_send_text"`
	LastReplyText string     `json:"last_reply_text"`
}

func (b *headlessFixtureBot) summary() headlessBotSummary {
	b.textMu.Lock()
	defer b.textMu.Unlock()
	b.mu.Lock()
	defer b.mu.Unlock()
	return headlessBotSummary{Ensures: b.ensures, Sends: b.sends, Replies: b.replies, Acks: b.acks, Deletes: b.deletes, LastAck: b.lastAck, LastReply: b.lastReply, LastSendText: b.lastSendText, LastReplyText: b.lastReplyText}
}
func headlessInstallFixtureBot(c *Core) (*headlessFixtureBot, error) {
	config := ProviderConfig{ID: headlessFixtureBotID, Name: "Headless integration fixture", Type: "feishu", Enabled: true, AppID: "fixture-app", AppSecret: "synthetic-fixture-secret", Recipient: "fixture-sender"}
	if err := validateProvider(config); err != nil {
		return nil, err
	}
	if err := c.store.Update(func(d *State) error { d.Providers[config.ID] = config; d.DefaultProvider = config.ID; return nil }); err != nil {
		return nil, err
	}
	bot := &headlessFixtureBot{fakeProvider: &fakeProvider{node: c.node(), id: config.ID}}
	c.mu.Lock()
	c.providers[config.ID] = bot
	c.statuses[config.ID] = "connected"
	c.mu.Unlock()
	return bot, nil
}

type headlessUpstreamReady struct {
	Kind         string `json:"kind"`
	NodeID       string `json:"node_id"`
	GRPCAddress  string `json:"grpc_address"`
	GRPCToken    string `json:"grpc_token"`
	ControlURL   string `json:"control_url"`
	ControlToken string `json:"control_token"`
}
type headlessEmitRequest struct {
	Session   Session `json:"session"`
	MessageID string  `json:"message_id"`
	EventID   string  `json:"event_id,omitempty"`
	Content   Content `json:"content"`
}
type headlessEventSummary struct {
	ID      string `json:"event_id"`
	Outcome string `json:"outcome"`
}

func headlessControlHandler(c *Core, bot *headlessFixtureBot, token string) http.Handler {
	requests := make(chan struct{}, 32)
	write := func(w http.ResponseWriter, status int, value any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
	}
	failure := func(w http.ResponseWriter, status int, code, message string) {
		write(w, status, map[string]any{"error": &rpcError{Code: code, Message: message}})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Values("Authorization")
		if len(auth) != 1 || subtle.ConstantTimeCompare([]byte(auth[0]), []byte("Bearer "+token)) != 1 {
			failure(w, http.StatusUnauthorized, "unauthenticated", "bearer authentication required")
			return
		}
		select {
		case requests <- struct{}{}:
			defer func() { <-requests }()
		default:
			failure(w, http.StatusServiceUnavailable, "resource_exhausted", "fixture request limit reached")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		switch r.URL.Path {
		case "/state":
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", http.MethodGet)
				failure(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET required")
				return
			}
			snapshot := c.store.Snapshot()
			events := make([]headlessEventSummary, 0, len(snapshot.Events))
			for id, event := range snapshot.Events {
				events = append(events, headlessEventSummary{ID: id, Outcome: event.Outcome})
			}
			sort.Slice(events, func(i, j int) bool { return events[i].ID < events[j].ID })
			write(w, http.StatusOK, map[string]any{"core": c.Status(), "bot": bot.summary(), "events": events})
		case "/emit":
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", http.MethodPost)
				failure(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxPayload+65536)
			defer r.Body.Close()
			decoder := json.NewDecoder(r.Body)
			decoder.DisallowUnknownFields()
			var input headlessEmitRequest
			if err := decoder.Decode(&input); err != nil {
				failure(w, http.StatusBadRequest, "invalid_argument", "invalid emit request")
				return
			}
			var extra any
			if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
				failure(w, http.StatusBadRequest, "invalid_argument", "emit requires one JSON object")
				return
			}
			if input.EventID == "" {
				input.EventID = input.MessageID
			}
			if input.MessageID == "" || input.EventID == "" || len(input.MessageID) > 4096 || len(input.EventID) > 4096 {
				failure(w, http.StatusBadRequest, "invalid_argument", "message and event IDs are required and bounded")
				return
			}
			if err := input.Session.validate(); err != nil {
				failure(w, http.StatusBadRequest, "invalid_argument", "full target session identity required")
				return
			}
			if err := input.Content.Validate(); err != nil {
				e := publicError(err)
				failure(w, http.StatusBadRequest, e.Code, e.Message)
				return
			}
			binding := c.store.Snapshot().Bindings[input.Session.key()]
			message := MessageRef{OriginNodeID: c.node(), ProviderID: headlessFixtureBotID, MessageID: input.MessageID}
			event := Event{ID: input.EventID, Session: input.Session, Message: message, Content: input.Content, Hops: 16, ChatID: binding.ChatID, SenderID: "fixture-sender"}
			if err := c.Ingest(ctx, event, ""); err != nil {
				e := publicError(err)
				failure(w, http.StatusServiceUnavailable, e.Code, e.Message)
				return
			}
			write(w, http.StatusOK, map[string]any{"event_id": event.ID, "message": message})
		default:
			failure(w, http.StatusNotFound, "not_found", "unknown fixture route")
		}
	})
}

// This is a TEST-BINARY-ONLY process entrypoint. Production binaries do not
// contain it. Every listener is loopback-only and no real provider is started.
func TestHeadlessIntegrationUpstream(t *testing.T) {
	stateDir, explicit := os.LookupEnv(headlessUpstreamStateEnv)
	if !explicit || stateDir == "" {
		t.Skip("headless upstream requires an explicit isolated state directory")
	}
	if !filepath.IsAbs(stateDir) {
		t.Fatal("headless upstream state directory must be absolute")
	}
	info, err := os.Lstat(stateDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("headless upstream requires an existing real empty directory")
	}
	entries, err := os.ReadDir(stateDir)
	if err != nil || len(entries) != 0 {
		t.Fatal("headless upstream refuses a nonempty state directory")
	}
	store, err := OpenStore(stateDir)
	if err != nil {
		t.Fatal("cannot open isolated headless upstream state")
	}
	defer store.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	core, err := NewCore(ctx, store, nil)
	if err != nil {
		t.Fatal("cannot initialize headless upstream core")
	}
	defer core.Close()
	bot, err := headlessInstallFixtureBot(core)
	if err != nil {
		t.Fatal("cannot install synthetic headless bot")
	}
	remote := RemoteConfig{Enabled: true, Listen: "127.0.0.1:0", Token: uid() + uid()}
	if err = store.Update(func(d *State) error { d.Remote = remote; return nil }); err != nil {
		t.Fatal("cannot persist isolated upstream listener")
	}
	// Deliberately do not call Core.Start: that would instantiate a real bot.
	if err = core.startServer(remote); err != nil {
		t.Fatal("cannot start loopback upstream gRPC listener")
	}
	core.mu.Lock()
	grpcAddress := core.server.listener.Addr().String()
	core.mu.Unlock()
	if err = store.Update(func(d *State) error { d.Remote.Listen = grpcAddress; return nil }); err != nil {
		t.Fatal("cannot persist upstream loopback address")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("cannot start headless control listener")
	}
	controlToken := uid() + uid()
	server := &http.Server{Handler: headlessControlHandler(core, bot, controlToken), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10, ErrorLog: log.New(io.Discard, "", 0), BaseContext: func(net.Listener) context.Context { return ctx }}
	defer server.Close()
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	// EOF from the parent is the normal shutdown path; SIGTERM also cancels.
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	ready := headlessUpstreamReady{Kind: "upstream-ready", NodeID: core.node(), GRPCAddress: grpcAddress, GRPCToken: remote.Token, ControlURL: "http://" + listener.Addr().String(), ControlToken: controlToken}
	if err = json.NewEncoder(os.Stdout).Encode(ready); err != nil {
		t.Fatal("cannot announce headless upstream readiness")
	}
	select {
	case <-ctx.Done():
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Fatal("headless control listener failed")
		}
	}
	shutdownCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	_ = server.Shutdown(shutdownCtx)
	// Deferred Core.Close closes gRPC/streams, then Store.Close releases its lock.
}

type headlessTestProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
	err  error
}

func headlessTestCommand(t *testing.T, stateDir string) (*headlessTestProcess, io.WriteCloser, *bufio.Reader) {
	t.Helper()
	executable, err := os.Executable()
	must(t, err)
	cmd := exec.Command(executable, "-test.run=^TestHeadlessIntegrationUpstream$", "-test.timeout=20s")
	env := []string{}
	for _, entry := range os.Environ() {
		if len(entry) >= len(headlessUpstreamStateEnv)+1 && entry[:len(headlessUpstreamStateEnv)+1] == headlessUpstreamStateEnv+"=" {
			continue
		}
		env = append(env, entry)
	}
	cmd.Env = append(env, headlessUpstreamStateEnv+"="+stateDir)
	stdin, err := cmd.StdinPipe()
	must(t, err)
	stdout, err := cmd.StdoutPipe()
	must(t, err)
	cmd.Stderr = io.Discard
	must(t, cmd.Start())
	process := &headlessTestProcess{cmd: cmd, done: make(chan struct{})}
	go func() { process.err = cmd.Wait(); close(process.done) }()
	t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-process.done:
		default:
			_ = cmd.Process.Kill()
			<-process.done
		}
	})
	return process, stdin, bufio.NewReader(stdout)
}
func TestHeadlessIntegrationRejectsNonemptyDirectory(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "must-remain")
	must(t, os.WriteFile(marker, []byte("unchanged"), 0600))
	process, stdin, _ := headlessTestCommand(t, dir)
	_ = stdin.Close()
	select {
	case <-process.done:
		if process.err == nil {
			t.Fatal("fixture accepted a nonempty directory")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("fixture did not reject nonempty state promptly")
	}
	entries, err := os.ReadDir(dir)
	must(t, err)
	if len(entries) != 1 || entries[0].Name() != "must-remain" {
		t.Fatal("fixture touched a rejected directory")
	}
	raw, err := os.ReadFile(marker)
	must(t, err)
	if string(raw) != "unchanged" {
		t.Fatal("fixture changed rejected state")
	}
}
func TestHeadlessIntegrationProcessUsesRealRPCAndStopsOnEOF(t *testing.T) {
	dir := t.TempDir()
	process, stdin, stdout := headlessTestCommand(t, dir)
	type readyResult struct {
		ready headlessUpstreamReady
		err   error
	}
	announced := make(chan readyResult, 1)
	go func() {
		line, err := stdout.ReadBytes('\n')
		var ready headlessUpstreamReady
		if err == nil {
			err = json.Unmarshal(line, &ready)
		}
		announced <- readyResult{ready, err}
	}()
	var ready headlessUpstreamReady
	select {
	case value := <-announced:
		must(t, value.err)
		ready = value.ready
	case <-time.After(5 * time.Second):
		t.Fatal("headless fixture did not become ready")
	}
	if ready.Kind != "upstream-ready" || ready.NodeID == "" || ready.GRPCToken == "" || ready.ControlToken == "" {
		t.Fatal("headless readiness contract is incomplete")
	}
	host, _, err := net.SplitHostPort(ready.GRPCAddress)
	must(t, err)
	if host != "127.0.0.1" {
		t.Fatal("fixture exposed gRPC outside numeric loopback")
	}
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	control := func(method, path string, body any, auth bool, status int) json.RawMessage {
		t.Helper()
		var input io.Reader
		if body != nil {
			raw, err := json.Marshal(body)
			must(t, err)
			input = bytes.NewReader(raw)
		}
		request, err := http.NewRequest(method, ready.ControlURL+path, input)
		must(t, err)
		if auth {
			request.Header.Set("Authorization", "Bearer "+ready.ControlToken)
		}
		response, err := client.Do(request)
		must(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(response.Body, 2*maxPayload))
		must(t, err)
		if response.StatusCode != status {
			t.Fatalf("fixture HTTP status %d, expected %d", response.StatusCode, status)
		}
		return raw
	}
	control(http.MethodGet, "/state", nil, false, http.StatusUnauthorized)
	first, connection, _ := streamClient(t, ready.GRPCAddress, ready.GRPCToken, "headless-peer-b")
	second, _, _ := streamClient(t, ready.GRPCAddress, ready.GRPCToken, "headless-peer-c")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+ready.GRPCToken, "nootify-node-id", "headless-peer-b")
	rpc := func(method string, params any) json.RawMessage {
		t.Helper()
		raw, err := json.Marshal(params)
		must(t, err)
		result, err := pb.NewNotificationCoreClient(connection).Call(ctx, &pb.Command{Method: method, ParamsJson: raw, VisitedNodes: []string{"headless-peer-b"}})
		must(t, err)
		if result.ErrorCode != "" {
			t.Fatalf("fixture RPC failed: %s", result.ErrorCode)
		}
		return result.ResultJson
	}
	session := Session{NodeID: "headless-peer-b", Adapter: "trae", SessionID: "fixture-session", Name: "Headless"}
	var binding Binding
	must(t, json.Unmarshal(rpc("session.ensure", map[string]any{"session": session}), &binding))
	if binding.ProviderID != headlessFixtureBotID || binding.ChatID == "" {
		t.Fatal("fixture did not use production session ensure")
	}
	rpc("message.send", map[string]any{"session": session, "content": Content{Text: "progress"}, "request_id": "send-fixture"})
	var emitted struct {
		ID      string     `json:"event_id"`
		Message MessageRef `json:"message"`
	}
	must(t, json.Unmarshal(control(http.MethodPost, "/emit", headlessEmitRequest{Session: session, MessageID: "incoming", Content: Content{Text: "continue"}}, true, http.StatusOK), &emitted))
	a, err := first.Recv()
	must(t, err)
	b, err := second.Recv()
	must(t, err)
	if a.GetEvent() == nil || b.GetEvent() == nil || a.GetEvent().EventId != emitted.ID || b.GetEvent().EventId != emitted.ID {
		t.Fatal("fixture did not broadcast through real gRPC to both peers")
	}
	must(t, first.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: emitted.ID}}}))
	var state struct {
		Bot  headlessBotSummary `json:"bot"`
		Core struct {
			Remote RemoteSummary `json:"remote"`
		} `json:"core"`
	}
	await(t, func() bool {
		must(t, json.Unmarshal(control(http.MethodGet, "/state", nil, true, http.StatusOK), &state))
		pending := map[string]int{}
		for _, peer := range state.Core.Remote.Peers {
			pending[peer.NodeID] = peer.Pending
		}
		return len(pending) == 2 && pending["headless-peer-b"] == 0 && pending["headless-peer-c"] == 1
	})
	rpc("message.ack", map[string]any{"message": emitted.Message})
	rpc("message.reply", map[string]any{"message": emitted.Message, "content": Content{Blocks: []ContentBlock{{Type: "code", Text: "reply text"}}}, "request_id": "reply-fixture"})
	rpc("session.delete", map[string]any{"session": session})
	must(t, json.Unmarshal(control(http.MethodGet, "/state", nil, true, http.StatusOK), &state))
	if state.Bot.Ensures != 1 || state.Bot.Sends != 1 || state.Bot.Replies != 1 || state.Bot.Acks != 1 || state.Bot.Deletes != 1 || state.Bot.LastSendText != "progress" || state.Bot.LastReplyText != "reply text" || state.Bot.LastAck != emitted.Message || state.Bot.LastReply != emitted.Message {
		t.Fatal("fixture bot counters, text or full message references were lost")
	}
	if len(state.Core.Remote.Peers) != 2 {
		t.Fatal("fixture state omitted independently subscribed peers")
	}
	must(t, stdin.Close())
	select {
	case <-process.done:
		must(t, process.err)
	case <-time.After(5 * time.Second):
		t.Fatal("fixture did not close on stdin EOF")
	}
	store, err := OpenStore(dir)
	must(t, err)
	must(t, store.Close())
}

var _ Bot = (*headlessFixtureBot)(nil)
