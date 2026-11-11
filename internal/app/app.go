// Package app is the shared Go service and command-line entry point. The MyGo
// executable dispatches these commands before initializing native UI resources.
package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/idy/nootify/internal/host"
	"github.com/idy/nootify/internal/providers"
	"github.com/idy/nootify/internal/service"
	"github.com/idy/nootify/internal/storage"
	"github.com/idy/nootify/internal/webui"
	assets "github.com/idy/nootify/public"
)

var commands = map[string]bool{"serve": true, "health": true, "sessions": true, "register": true, "send": true, "ui-url": true, "thread-open": true, "thread-send": true, "thread-delete": true, "thread-receive": true, "thread-ack": true, "message-ack": true, "message-reply": true, "lark-ack": true, "lark-reply": true, "lark-bind": true, "lark-recipient": true, "backend-set": true, "node-identity": true, "peer-bind": true, "launchd-install": true}

func Run(parent context.Context, args []string, version string, stdout, stderr io.Writer) (handled bool, runErr error) {
	if len(args) == 0 {
		return false, nil
	}
	command := args[0]
	if command == "--help" || command == "-h" {
		_, err := fmt.Fprintln(stdout, "Nootify: serve, health, sessions, register, send, thread-open/send/delete/receive/ack, message-ack/reply, ui-url, service-install/start/restart/stop/uninstall/status")
		return true, err
	}
	if !commands[command] && !strings.HasPrefix(command, "service-") {
		return false, nil
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	values := map[string]*string{}
	for _, name := range []string{"state-dir", "mcp-config", "session-id", "session-name", "adapter", "agent", "open-id", "chat-id", "sender-id", "metadata", "text", "text-file", "url", "directory", "message-id", "message-ref", "provider-id", "request-id", "peer-node-id", "public-key", "ui-route", "service-drain"} {
		values[name] = flags.String(name, "", "")
	}
	port := flags.Int("port", 9417, "")
	pin := flags.Bool("pin", false, "")
	managed := flags.Bool("ui-managed", false, "")
	serviceManaged := flags.Bool("service-managed", false, "")
	help := flags.Bool("help", false, "")
	flags.BoolVar(help, "h", false, "")
	channel := flags.String("channel", "", "")
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return true, nil
		}
		return true, err
	}
	if *help {
		_, _ = fmt.Fprintln(stdout, "Nootify serve | health | sessions | thread-open | thread-send | thread-delete | thread-receive | thread-ack | message-ack | message-reply | ui-url | service-install/start/restart/stop/uninstall/status")
		return true, nil
	}
	if flags.NArg() != 0 {
		return true, errors.New("unexpected positional arguments")
	}
	if *port < 0 || *port > 65535 || *port == 0 && command != "serve" {
		return true, errors.New("invalid port")
	}
	if *channel != "" && *channel != "feishu" {
		return true, errors.New("only Feishu notifications are supported")
	}
	value := func(name string) string { return *values[name] }
	required := func(name string) (string, error) {
		if value(name) == "" {
			return "", fmt.Errorf("missing --%s", name)
		}
		return value(name), nil
	}
	executable, err := os.Executable()
	if err != nil {
		return true, err
	}
	directory := value("state-dir")
	if directory == "" {
		directory = storage.DefaultDir()
	}
	options := service.Options{StateDir: directory, Port: *port, MCPConfig: value("mcp-config"), Executable: executable, Drain: json.RawMessage(value("service-drain"))}
	if command == "serve" {
		ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if *serviceManaged {
			cleanup, err := service.PrepareServe(ctx, options)
			if err != nil {
				return true, err
			}
			defer cleanup()
			logOut, logErr, err := service.ManagedOutput(options)
			if err != nil {
				return true, err
			}
			defer logOut.Close()
			defer logErr.Close()
			stdout, stderr = logOut, logErr
			defer func() {
				if runErr != nil {
					_ = json.NewEncoder(stderr).Encode(service.Failure(runErr))
				}
			}()
		}
		refreshPrompts := *serviceManaged
		if bundled, _ := service.Current(); bundled != nil {
			refreshPrompts = true
		}
		server, err := host.New(ctx, host.Options{StateDir: directory, Port: *port, MCPConfig: value("mcp-config"), Version: version, Executable: executable, Assets: assets.FS, Output: stdout, RefreshPrompts: refreshPrompts})
		if err != nil {
			return true, err
		}
		defer server.Close()
		return true, server.Wait(ctx)
	}
	if strings.HasPrefix(command, "service-") || command == "launchd-install" {
		action := strings.TrimPrefix(command, "service-")
		if command == "launchd-install" {
			action = "install"
		}
		result, err := service.Manage(parent, action, options)
		if err != nil {
			return true, err
		}
		return true, json.NewEncoder(stdout).Encode(result)
	}
	tokenBytes, err := os.ReadFile(filepath.Join(directory, "auth-token"))
	if err != nil && command != "health" {
		return true, err
	}
	token := strings.TrimSpace(string(tokenBytes))
	base := "http://127.0.0.1:" + strconv.Itoa(*port)
	if command == "ui-url" {
		ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
		defer cancel()
		gateway, err := webui.NewGateway(ctx, webui.Options{BaseURL: base, Token: token, Route: value("ui-route"), Assets: assets.FS})
		if err != nil {
			return true, err
		}
		defer gateway.Close()
		if err = json.NewEncoder(stdout).Encode(map[string]string{"url": gateway.URL}); err != nil {
			return true, err
		}
		if *managed {
			go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
		}
		select {
		case <-ctx.Done():
		case <-gateway.Done():
		}
		return true, nil
	}
	request := func(method, path string, body any) (any, error) {
		return requestJSON(parent, base, token, method, path, body)
	}
	var result any
	method, path := "", ""
	var body any
	adapter := value("adapter")
	if adapter == "" {
		adapter = "claude-desktop"
	}
	text := func() (string, error) {
		if value("text") != "" && value("text-file") != "" {
			return "", errors.New("use --text or --text-file, not both")
		}
		message := value("text")
		if file := value("text-file"); file != "" {
			var reader io.Reader
			if file == "-" {
				reader = os.Stdin
			} else {
				f, e := os.Open(file)
				if e != nil {
					return "", e
				}
				defer f.Close()
				reader = f
			}
			raw, e := io.ReadAll(io.LimitReader(reader, 48001))
			if e != nil {
				return "", e
			}
			if len(raw) > 48000 {
				return "", errors.New("text is too large")
			}
			message = string(raw)
		}
		if strings.TrimSpace(message) == "" {
			return "", errors.New("provide --text or --text-file")
		}
		return message, nil
	}
	target := func() (string, string, error) {
		kind := value("adapter")
		id := value("session-id")
		agent := value("agent")
		switch agent {
		case "claude":
			kind = first(kind, "claude-code")
			detected := os.Getenv("CLAUDE_CODE_HOST_SESSION_ID")
			if detected != "" {
				kind = first(value("adapter"), "claude-desktop")
			}
			id = first(id, detected, os.Getenv("CLAUDE_CODE_SESSION_ID"))
		case "codex":
			kind = first(kind, "codex")
			id = first(id, os.Getenv("CODEX_THREAD_ID"))
		case "opencode", "trae", "workbuddy":
			kind = first(kind, agent)
		case "":
		default:
			return "", "", errors.New("unsupported agent")
		}
		if !providers.ValidAdapter(kind) {
			return "", "", errors.New("pass --agent or --adapter with --session-id")
		}
		if id == "" && command == "thread-open" && (kind == "trae" || kind == "workbuddy") {
			id = uuid()
		}
		if _, e := providers.Identifier(id, "session_id"); e != nil {
			return "", "", errors.New("pass --session-id for this conversation")
		}
		return kind, id, nil
	}
	switch command {
	case "health":
		method, path = "GET", "/health"
	case "sessions":
		method, path = "GET", "/v1/sessions"
	case "node-identity":
		method, path = "GET", "/v1/remote/identity"
	case "peer-bind":
		id, e := required("peer-node-id")
		if e != nil {
			return true, e
		}
		key, e := required("public-key")
		if e != nil {
			return true, e
		}
		method, path, body = "PUT", "/v1/remote/peers/"+url.PathEscape(id), map[string]any{"public_key": key}
	case "register":
		id, e := required("session-id")
		if e != nil {
			return true, e
		}
		name, e := required("session-name")
		if e != nil {
			return true, e
		}
		registration := map[string]any{"adapter": adapter, "session_name": name}
		if adapter == "claude-code" || adapter == "claude-desktop" {
			socket := os.Getenv("CLAUDE_CODE_MESSAGING_SOCKET")
			if socket == "" {
				return true, errors.New("register from the target session: its inbox environment is missing")
			}
			registration["socket_path"] = socket
			if value := os.Getenv("CLAUDE_CODE_MESSAGING_TOKEN"); value != "" {
				registration["socket_token"] = value
			}
		}
		method, path, body = "PUT", "/v1/sessions/"+url.PathEscape(id), registration
	case "send":
		id, e := required("session-id")
		if e != nil {
			return true, e
		}
		message, e := text()
		if e != nil {
			return true, e
		}
		method, path, body = "POST", "/v1/sessions/"+url.PathEscape(id)+"/messages", map[string]any{"adapter": adapter, "text": message}
	case "thread-open", "thread-send", "thread-delete", "thread-receive", "thread-ack":
		kind, id, e := target()
		if e != nil {
			return true, e
		}
		params := map[string]any{"adapter": kind}
		if provider := value("provider-id"); provider != "" {
			params["provider_id"] = provider
		}
		if *channel != "" {
			params["channel"] = *channel
		}
		switch command {
		case "thread-open":
			name, e := required("session-name")
			if e != nil {
				return true, e
			}
			params["session_id"] = id
			params["session_name"] = name
			method, path = "POST", "/v1/threads"
		case "thread-send":
			message, e := text()
			if e != nil {
				return true, e
			}
			params["text"] = message
			if id := value("request-id"); id != "" {
				params["request_id"] = id
			}
			method, path = "POST", "/v1/threads/"+url.PathEscape(id)+"/messages"
		case "thread-delete":
			method, path = "DELETE", "/v1/threads/"+url.PathEscape(id)
		case "thread-receive", "thread-ack":
			if kind != "trae" && kind != "workbuddy" {
				return true, errors.New("thread inbox is supported for trae and workbuddy")
			}
			method, path = "POST", "/v1/sessions/"+url.PathEscape(id)+"/inbox"
			if command == "thread-ack" {
				messageID, e := required("message-id")
				if e != nil {
					return true, e
				}
				path += "/" + url.PathEscape(messageID) + "/ack"
			}
		}
		body = params
	case "message-ack", "message-reply", "lark-ack", "lark-reply":
		isProvider := strings.HasPrefix(command, "message-")
		idKey := "message-id"
		prefix := "/v1/lark/messages/"
		if isProvider {
			idKey = "message-ref"
			prefix = "/v1/provider-messages/"
		}
		id, e := required(idKey)
		if e != nil {
			return true, e
		}
		action := "ack"
		params := map[string]any{}
		if strings.HasSuffix(command, "reply") {
			action = "reply"
			message, e := text()
			if e != nil {
				return true, e
			}
			params["text"] = message
		}
		method, path, body = "POST", prefix+url.PathEscape(id)+"/"+action, params
	case "lark-recipient":
		method, path = "GET", "/v1/lark/recipient"
		if openID := value("open-id"); openID != "" {
			method, body = "PUT", map[string]any{"open_id": openID}
		}
	case "backend-set":
		if adapter != "codex" && adapter != "opencode" {
			return true, errors.New("choose --adapter codex or opencode")
		}
		address, e := required("url")
		if e != nil {
			return true, e
		}
		params := map[string]any{"url": address}
		if dir := value("directory"); dir != "" {
			params["directory"] = dir
		}
		if adapter == "codex" {
			if token := os.Getenv("CODEX_APP_SERVER_TOKEN"); token != "" {
				params["token"] = token
			}
		} else {
			for key, env := range map[string]string{"username": "OPENCODE_SERVER_USERNAME", "password": "OPENCODE_SERVER_PASSWORD"} {
				if v := os.Getenv(env); v != "" {
					params[key] = v
				}
			}
		}
		method, path, body = "PUT", "/v1/backends/"+adapter, params
	case "lark-bind":
		chat, e := required("chat-id")
		if e != nil {
			return true, e
		}
		id, e := required("session-id")
		if e != nil {
			return true, e
		}
		sender, e := required("sender-id")
		if e != nil {
			return true, e
		}
		params := map[string]any{"session_id": id, "adapter": adapter, "sender_open_id": sender, "pin": *pin}
		if name := value("session-name"); name != "" {
			params["session_name"] = name
		}
		if metadata := value("metadata"); metadata != "" {
			params["metadata"] = metadata
		}
		method, path, body = "PUT", "/v1/lark/bindings/"+url.PathEscape(chat), params
	default:
		return true, errors.New("unsupported command")
	}
	result, err = request(method, path, body)
	if err != nil {
		if command == "thread-open" {
			params, _ := body.(map[string]any)
			kind, _ := params["adapter"].(string)
			if kind == "trae" || kind == "workbuddy" {
				return true, fmt.Errorf("%w; retry thread-open with --agent %s --session-id %s", err, kind, params["session_id"])
			}
		}
		return true, err
	}
	return true, json.NewEncoder(stdout).Encode(result)
}
func requestJSON(parent context.Context, base, token, method, path string, body any) (any, error) {
	ctx, cancel := context.WithTimeout(parent, 75*time.Second)
	defer cancel()
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	request.Header.Set("authorization", "Bearer "+token)
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 4*1024*1024 {
		return nil, errors.New("service response exceeds limit")
	}
	var result any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err = decoder.Decode(&result); err != nil {
		return nil, errors.New("invalid service response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if fields, ok := result.(map[string]any); ok {
			if message, ok := fields["error"].(string); ok {
				return nil, errors.New(message)
			}
		}
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	return result, nil
}
func first(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
func uuid() string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	raw[6] = (raw[6] & 15) | 64
	raw[8] = (raw[8] & 63) | 128
	value := hex.EncodeToString(raw)
	return value[:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:]
}
