package providers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/idy/nootify/internal/httpx"
	"github.com/idy/nootify/internal/settings"
	core "github.com/idy/nootify/native/core"
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
var threadPattern = regexp.MustCompile(`^/v1/threads/([^/]+)(?:/(messages|metadata))?$`)
var callbackPattern = regexp.MustCompile(`^/v1/(?:lark/messages|provider-messages)/([^/]+)/(ack|reply)$`)

func ValidAdapter(value string) bool {
	switch value {
	case "claude-code", "claude-desktop", "codex", "opencode", "trae", "workbuddy":
		return true
	}
	return false
}
func Identifier(value any, field string) (string, error) {
	s, err := httpx.Text(value, field)
	if err != nil {
		return "", err
	}
	if !identifierPattern.MatchString(s) {
		return "", httpx.Fail(400, "Invalid "+field)
	}
	return s, nil
}
func DecodeReference(value string) (map[string]any, error) {
	if len(value) > 12000 || !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(value) {
		return nil, httpx.Fail(400, "Invalid message reference")
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, httpx.Fail(400, "Invalid message reference")
	}
	var ref map[string]any
	if json.Unmarshal(raw, &ref) != nil || ref == nil {
		return nil, httpx.Fail(400, "Invalid message reference")
	}
	for _, key := range []string{"origin_node_id", "provider_id", "message_id"} {
		if _, err = Identifier(ref[key], key); err != nil {
			return nil, err
		}
	}
	return ref, nil
}
func Status(err error) int {
	var httpErr *httpx.Error
	if errors.As(err, &httpErr) {
		return httpErr.Status
	}
	var settingsErr *settings.Error
	if errors.As(err, &settingsErr) {
		return settingsErr.Status
	}
	switch errorCode(err) {
	case "rejection_retryable", "unavailable", "timeout", "busy":
		return 503
	case "rejection_terminal":
		return 422
	case "not_found":
		return 404
	case "invalid_argument", "unsupported":
		return 400
	case "unauthenticated":
		return 401
	case "permission_denied":
		return 403
	case "conflict", "already_exists", "failed_precondition", "unconfirmed", "committed_not_durable", "committed_not_mirrored", "deleted":
		return 409
	case "resource_exhausted":
		return 429
	}
	return 500
}
func WriteError(w http.ResponseWriter, err error) {
	body := map[string]any{"error": err.Error()}
	if code := errorCode(err); code != "" {
		body["code"] = code
	}
	httpx.JSON(w, Status(err), body)
}
func (s *Service) Action(ctx context.Context, body map[string]any) (map[string]any, error) {
	var method string
	var params any
	switch body["action"] {
	case "save":
		method = "provider.save"
		provider, ok := body["provider"].(map[string]any)
		if !ok {
			return nil, httpx.Fail(400, "Expected a provider configuration")
		}
		params = provider
	case "reconnect":
		id, err := Identifier(body["id"], "id")
		if err != nil {
			return nil, err
		}
		return s.reconnect(ctx, id)
	case "delete", "default":
		id, err := Identifier(body["id"], "id")
		if err != nil {
			return nil, err
		}
		method = "provider." + str(body["action"])
		params = map[string]any{"id": id}
	default:
		return nil, httpx.Fail(400, "Expected a provider action: save, delete, default or reconnect")
	}
	if _, err := s.Call(ctx, method, params); err != nil {
		return nil, err
	}
	return s.Page(ctx)
}
func (s *Service) Remote(ctx context.Context) (map[string]any, error) {
	page, err := s.Page(ctx)
	if err != nil {
		return nil, err
	}
	remote := asMap(page["remote"])
	remote["node_id"] = page["node_id"]
	return remote, nil
}
func (s *Service) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result, err := s.handle(r)
		if err != nil {
			WriteError(w, err)
			return
		}
		httpx.JSON(w, 200, result)
	})
}
func (s *Service) localSession(ctx context.Context, id, adapter, name string) (map[string]any, error) {
	if _, err := Identifier(id, "session_id"); err != nil {
		return nil, err
	}
	if !ValidAdapter(adapter) {
		return nil, httpx.Fail(400, "Unsupported session adapter")
	}
	if name == "" {
		name = s.options.Sessions.SessionName(id, adapter)
	}
	runes := []rune(strings.TrimSpace(name))
	if len(runes) > 80 {
		runes = runes[:80]
	}
	page, err := s.Page(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"node_id": page["node_id"], "adapter": adapter, "session_id": id, "name": string(runes)}, nil
}
func (s *Service) threadSession(ctx context.Context, id string, body map[string]any) (map[string]any, error) {
	adapter := str(body["adapter"])
	if adapter == "" {
		page, err := s.Page(ctx)
		if err != nil {
			return nil, err
		}
		bindings, err := s.raw(ctx, "session.list", nil)
		if err != nil {
			return nil, err
		}
		candidates := map[string]bool{}
		scoped := map[string]bool{}
		for _, b := range listMaps(bindings) {
			session := asMap(b["session"])
			if session["node_id"] == page["node_id"] && session["session_id"] == id {
				a := str(session["adapter"])
				candidates[a] = true
				if str(body["provider_id"]) != "" && b["provider_id"] == body["provider_id"] {
					scoped[a] = true
				}
			}
		}
		if len(scoped) > 0 {
			candidates = scoped
		}
		if len(candidates) > 1 {
			return nil, httpx.Fail(409, "This session ID has multiple adapter bindings; specify adapter")
		}
		for a := range candidates {
			adapter = a
		}
		if adapter == "" {
			var saved map[string]any
			if ok, _ := s.options.Store.Get("sessions", id, &saved); ok {
				adapter = str(saved["adapter"])
			}
		}
		if adapter == "" {
			return nil, httpx.Fail(404, "No notification session with this ID; specify adapter")
		}
	}
	return s.localSession(ctx, id, adapter, "")
}
func (s *Service) handle(r *http.Request) (any, error) {
	ctx := r.Context()
	path := r.URL.Path
	body, err := httpx.ReadObject(r, 65536)
	if err != nil {
		return nil, err
	}
	if channel, exists := body["channel"]; exists && channel != "feishu" {
		return nil, httpx.Fail(400, "Only Feishu notifications are supported")
	}
	if path == "/v1/remote/identity" && r.Method == "GET" {
		return s.Call(ctx, "remote.identity", nil)
	}
	if strings.HasPrefix(path, "/v1/remote/peers/") && r.Method == "PUT" {
		id, err := Identifier(strings.TrimPrefix(path, "/v1/remote/peers/"), "node_id")
		if err != nil {
			return nil, err
		}
		key, err := httpx.Text(body["public_key"], "public_key")
		if err != nil {
			return nil, err
		}
		return s.Call(ctx, "remote.peer.bind", map[string]any{"node_id": id, "public_key": key})
	}
	if path == "/v1/providers" {
		if r.Method == "GET" {
			return s.Page(ctx)
		}
		if r.Method == "POST" {
			return s.Action(ctx, body)
		}
	}
	if path == "/v1/threads" && r.Method == "POST" {
		session, err := s.localSession(ctx, str(body["session_id"]), str(body["adapter"]), str(body["session_name"]))
		if err != nil {
			return nil, err
		}
		adapter, id := str(session["adapter"]), str(session["session_id"])
		if err = s.options.Sessions.RegisterPolledSession(adapter, id, str(session["name"])); err != nil {
			return nil, err
		}
		result, err := s.Call(ctx, "session.ensure", map[string]any{"session": session, "provider_id": body["provider_id"]})
		if err != nil {
			return nil, err
		}
		resultMap := asMap(result)
		resultMap["channel"] = "feishu"
		resultMap["session_id"] = id
		resultMap["adapter"] = adapter
		resultMap["session_name"] = session["name"]
		return resultMap, nil
	}
	if match := threadPattern.FindStringSubmatch(path); match != nil {
		id, err := url.PathUnescape(match[1])
		if err != nil {
			return nil, httpx.Fail(400, "Invalid session ID")
		}
		session, err := s.threadSession(ctx, id, body)
		if err != nil {
			return nil, err
		}
		params := map[string]any{"session": session}
		if provider := str(body["provider_id"]); provider != "" {
			params["provider_id"] = provider
		}
		if r.Method == "DELETE" && match[2] == "" {
			return s.Call(ctx, "session.delete", params)
		}
		if match[2] == "metadata" && (r.Method == "GET" || r.Method == "PUT") {
			method := "session.metadata.get"
			if r.Method == "PUT" {
				metadata, ok := body["metadata"].(map[string]any)
				if !ok {
					return nil, httpx.Fail(400, "Expected metadata object")
				}
				params["metadata"] = metadata
				method = "session.metadata.set"
			}
			return s.Call(ctx, method, params)
		}
		if match[2] == "messages" && r.Method == "POST" {
			content := body["content"]
			if content == nil {
				text, err := httpx.Text(body["text"], "text")
				if err != nil {
					return nil, err
				}
				content = map[string]any{"text": text}
			}
			params["content"] = content
			if requestID := str(body["request_id"]); requestID != "" {
				params["request_id"] = requestID
			}
			result, err := s.Call(ctx, "message.send", params)
			if err != nil {
				return nil, err
			}
			mapped := asMap(result)
			mapped["channel"] = "feishu"
			return mapped, nil
		}
	}
	if match := callbackPattern.FindStringSubmatch(path); match != nil && r.Method == "POST" {
		params := map[string]any{}
		id, err := url.PathUnescape(match[1])
		if err != nil {
			return nil, httpx.Fail(400, "Invalid message reference")
		}
		if strings.HasPrefix(path, "/v1/provider-messages/") {
			params["message"], err = DecodeReference(id)
		} else {
			params["message_id"], err = Identifier(id, "message_id")
		}
		if err != nil {
			return nil, err
		}
		if match[2] == "reply" {
			content := body["content"]
			if content == nil {
				text, err := httpx.Text(body["text"], "text")
				if err != nil {
					return nil, err
				}
				content = map[string]any{"text": text}
			}
			params["content"] = content
			requestID := str(body["request_id"])
			if requestID == "" {
				requestID = defaultReplyID(id, strings.HasPrefix(path, "/v1/provider-messages/"), content)
			}
			params["request_id"] = requestID
		}
		result, err := s.Call(ctx, "message."+match[2], params)
		if err != nil {
			if Status(err) == 404 && strings.HasPrefix(path, "/v1/lark/messages/") {
				return s.legacyCallback(ctx, id, match[2], str(body["text"]))
			}
			return nil, err
		}
		if match[2] == "reply" {
			mapped := asMap(result)
			mapped["status"] = "replied"
			mapped["reply_id"] = mapped["message_id"]
			return mapped, nil
		}
		return result, nil
	}
	if strings.HasPrefix(path, "/v1/lark/bindings/") && r.Method == "PUT" {
		if pin, exists := body["pin"]; exists {
			if value, ok := pin.(bool); !ok || value {
				return nil, httpx.Fail(400, "Pinning binding messages is not supported")
			}
		}
		metadata := body["metadata"]
		if metadata == "announcement" {
			metadata = nil
		}
		if metadata != nil {
			if _, ok := metadata.(map[string]any); !ok {
				return nil, httpx.Fail(400, "Invalid binding metadata; expected an object")
			}
		}
		chatID, err := Identifier(strings.TrimPrefix(path, "/v1/lark/bindings/"), "chat_id")
		if err != nil {
			return nil, err
		}
		sender, err := Identifier(body["sender_open_id"], "sender_open_id")
		if err != nil {
			return nil, err
		}
		session, err := s.localSession(ctx, str(body["session_id"]), first(str(body["adapter"]), "claude-desktop"), str(body["session_name"]))
		if err != nil {
			return nil, err
		}
		if metadata != nil {
			session["metadata"] = metadata
		}
		if err = s.options.Sessions.RegisterPolledSession(str(session["adapter"]), str(session["session_id"]), str(session["name"])); err != nil {
			return nil, err
		}
		result, err := s.Call(ctx, "session.bind", map[string]any{"session": session, "chat_id": chatID, "sender_open_id": sender, "provider_id": body["provider_id"]})
		if err != nil {
			return nil, err
		}
		mapped := asMap(result)
		mapped["session_id"] = session["session_id"]
		mapped["adapter"] = session["adapter"]
		mapped["session_name"] = session["name"]
		return mapped, nil
	}
	if path == "/v1/lark/bindings" && r.Method == "GET" {
		bindings, err := s.Call(ctx, "session.list", nil)
		if err != nil {
			return nil, err
		}
		result := []map[string]any{}
		for _, binding := range listMaps(bindings) {
			if binding["deleted"] == true {
				continue
			}
			resources := append([]map[string]any{binding}, listMaps(binding["aliases"])...)
			for _, resource := range resources {
				if resource["deleted"] == true || str(resource["chat_id"]) == "" {
					continue
				}
				session := asMap(resource["session"])
				result = append(result, map[string]any{"chat_id": resource["chat_id"], "thread_id": resource["thread_id"], "provider_id": resource["provider_id"], "node_id": session["node_id"], "session_id": session["session_id"], "adapter": session["adapter"], "session_name": session["name"], "sender_open_id": resource["sender_open_id"], "metadata": "announcement", "pin": false})
			}
		}
		return result, nil
	}
	if path == "/v1/lark/recipient" {
		if r.Method == "GET" {
			return map[string]any{"open_id": s.options.Store.Setting("lark_recipient_open_id")}, nil
		}
		if r.Method == "PUT" {
			id, err := Identifier(body["open_id"], "open_id")
			if err != nil || !strings.HasPrefix(id, "ou_") {
				return nil, httpx.Fail(400, "Invalid recipient open_id")
			}
			_, err = s.Call(ctx, "compatibility.configure", map[string]any{"recipient_open_id": id})
			if err != nil {
				return nil, err
			}
			return map[string]any{"open_id": id}, nil
		}
	}
	return nil, httpx.Fail(404, "No such service endpoint")
}

// Keep the legacy CLI's {message:{message|message_id},content} fingerprint,
// including the original reference key order carried in an old callback URL.
func defaultReplyID(id string, provider bool, content any) string {
	var identity json.RawMessage
	if provider {
		raw, _ := base64.RawURLEncoding.DecodeString(id)
		var compact bytes.Buffer
		_ = json.Compact(&compact, raw)
		identity = json.RawMessage(append(append([]byte(`{"message":`), compact.Bytes()...), '}'))
	} else {
		raw, _ := json.Marshal(struct {
			MessageID string `json:"message_id"`
		}{id})
		identity = raw
	}
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(struct {
		Message json.RawMessage `json:"message"`
		Content any             `json:"content"`
	}{identity, content})
	sum := sha256.Sum256(bytes.TrimSuffix(data.Bytes(), []byte{'\n'}))
	return hex.EncodeToString(sum[:])
}

// RawCall is reserved for lifecycle/configuration reconciliation. It cannot
// recurse into the outer configuration queue.
func (s *Service) RawCall(ctx context.Context, method string, params any) (any, error) {
	return s.raw(ctx, method, params)
}

var _ = core.PublicError
