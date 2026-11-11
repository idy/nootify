package settings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// Handler serves /ui/api/settings routes. The host MUST require local owner authentication
// and same-origin UI authorization for every POST, including secret reveal and directory reads.
// The parent owns /ui/api/settings/remote and /remote/secret and must route them before this handler.
func (s *Service) Handler() http.Handler { return http.HandlerFunc(s.serveHTTP) }
func (s *Service) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	path := r.URL.Path
	editable := s.options.Editable != nil && s.options.Editable(r)
	if path == "/ui/api/settings/remote" || strings.HasPrefix(path, "/ui/api/settings/remote/") {
		writeError(w, problem(404, "No such settings route"))
		return
	}
	var result any
	var err error
	if r.Method == http.MethodGet {
		switch path {
		case "/ui/api/settings":
			var page map[string]any
			page, err = s.Page(r.Context())
			if err == nil {
				page["editable"] = editable
				result = page
			}
		case "/ui/api/settings/github":
			if s.options.GitHub == nil {
				err = problem(404, "GitHub settings are not enabled")
			} else {
				result, err = s.options.GitHub(r.Context())
				if err == nil && !editable {
					result = redactLogin(result)
				}
			}
		case "/ui/api/settings/tailscale":
			if s.options.Tailscale == nil {
				err = problem(404, "Tailscale settings are not enabled")
			} else {
				result, err = s.options.Tailscale(r.Context(), "page", nil)
				if err == nil {
					var page map[string]any
					page, err = jsonObject(result)
					if err == nil {
						page["editable"] = editable
						result = page
						if !editable {
							result = redactLogin(page)
						}
					}
				}
			}
		case "/ui/api/settings/lark/secret":
			err = problem(405, "Secret reveal requires a local POST")
		default:
			err = problem(404, "No such settings route")
		}
	} else if r.Method == http.MethodPost {
		switch path {
		case "/ui/api/settings/lark/secret":
			result, err = s.LarkSecret(r.Context())
		case "/ui/api/settings/export":
			result, err = s.ExportConfig(r.Context())
		case "/ui/api/settings/reveal":
			err = s.Reveal(r.Context())
			result = map[string]any{"accepted": true}
		case "/ui/api/settings/lark/recipients":
			result, err = s.Recipients(r.Context(), nil, false)
		default:
			maximum := int64(4096)
			if path == "/ui/api/settings/import" {
				maximum = 1024 * 1024
			}
			var body map[string]any
			body, err = decodeBody(w, r, maximum)
			if err == nil {
				if path == "/ui/api/settings/lark/recipients/stream" {
					s.streamRecipients(w, r, body["refresh"] == true)
					return
				}
				result, err = s.action(r.Context(), path, body)
			}
		}
	} else {
		err = problem(405, "Expected GET or POST")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
func (s *Service) action(ctx context.Context, path string, body map[string]any) (any, error) {
	switch path {
	case "/ui/api/settings/lark":
		var e error
		if body["clear"] == true {
			e = s.ClearLark(ctx)
		} else {
			e = s.SaveLark(ctx, body["app_id"], body["app_secret"], body["connection_type"])
		}
		return map[string]any{"accepted": true}, e
	case "/ui/api/settings/recipient":
		e := s.SetRecipient(ctx, body["open_id"], body["app_id"])
		return map[string]any{"accepted": true}, e
	case "/ui/api/settings/lark/permissions":
		return s.LarkSetup(ctx, body["app_id"])
	case "/ui/api/settings/lark/registration":
		switch body["action"] {
		case "status":
			return s.Registration(), nil
		case "start":
			return s.StartRegistration()
		case "cancel":
			return s.CancelRegistration()
		}
		return nil, problem(400, "Expected a Feishu registration action: start, status or cancel")
	case "/ui/api/settings/import":
		if body["apply"] == true {
			return s.ImportConfig(ctx, body["document"])
		}
		return s.PreviewImport(body["document"])
	case "/ui/api/settings/github/login":
		if s.options.GitHubAction == nil {
			return nil, problem(404, "GitHub settings are not enabled")
		}
		action := text(body["action"])
		switch action {
		case "start", "cancel", "sign-out":
			v, e := s.options.GitHubAction(ctx, action)
			if action == "sign-out" {
				v = map[string]any{"accepted": true}
			}
			return v, e
		}
		return nil, problem(400, "Expected a GitHub action: start, cancel or sign-out")
	case "/ui/api/settings/tailscale":
		if s.options.Tailscale == nil {
			return nil, problem(404, "Tailscale settings are not enabled")
		}
		action := text(body["action"])
		switch action {
		case "enable":
			enabled, ok := body["enabled"].(bool)
			if !ok {
				return nil, problem(400, "Expected enabled to be a boolean")
			}
			return s.options.Tailscale(ctx, action, &enabled)
		case "login", "cancel", "logout":
			v, e := s.options.Tailscale(ctx, action, nil)
			if action != "login" {
				v = map[string]any{"accepted": true}
			}
			return v, e
		}
		return nil, problem(400, "Expected a Tailscale action: enable, login, cancel or logout")
	}
	return nil, problem(404, "No such settings action")
}
func decodeBody(w http.ResponseWriter, r *http.Request, limit int64) (map[string]any, error) {
	b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if e != nil {
		var big *http.MaxBytesError
		if errors.As(e, &big) {
			return nil, problem(413, "Request body is too large")
		}
		return nil, problem(400, "Could not read request body")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	var body map[string]any
	if dec.Decode(&body) != nil || body == nil {
		return nil, problem(400, "Expected a JSON object")
	}
	var extra any
	if e = dec.Decode(&extra); e != io.EOF {
		return nil, problem(400, "Invalid JSON")
	}
	return body, nil
}
func redactLogin(v any) any {
	m, e := jsonObject(v)
	if e != nil || m == nil {
		return v
	}
	login := object(m["login"])
	m["login"] = map[string]any{"status": login["status"]}
	return m
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func settingsError(err error) *Error {
	var own *Error
	if errors.As(err, &own) {
		return own
	}
	code := ""
	var coded interface{ Code() string }
	var errorCoded interface{ ErrorCode() string }
	if errors.As(err, &coded) {
		code = coded.Code()
	} else if errors.As(err, &errorCoded) {
		code = errorCoded.ErrorCode()
	} else {
		for e := err; e != nil; e = errors.Unwrap(e) {
			var body struct {
				Code string `json:"code"`
			}
			b, _ := json.Marshal(e)
			if json.Unmarshal(b, &body) == nil && body.Code != "" {
				code = body.Code
				break
			}
		}
	}
	status := 500
	switch code {
	case "invalid_argument":
		status = 400
	case "unauthenticated":
		status = 401
	case "permission_denied":
		status = 403
	case "not_found", "method_not_found":
		status = 404
	case "conflict", "committed_not_durable", "committed_not_mirrored":
		status = 409
	case "resource_exhausted":
		status = 429
	case "unavailable":
		status = 503
	case "deadline_exceeded":
		status = 504
	}
	if errors.Is(err, context.Canceled) {
		status = 499
	}
	if errors.Is(err, context.DeadlineExceeded) {
		status = 504
	}
	return &Error{Status: status, Message: err.Error(), Code: code}
}
func writeError(w http.ResponseWriter, err error) {
	failure := settingsError(err)
	writeJSON(w, failure.Status, failure)
}
func (s *Service) streamRecipients(w http.ResponseWriter, r *http.Request, refresh bool) {
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.WriteHeader(200)
	controller := http.NewResponseController(w)
	_ = controller.Flush()
	send := func(v any) {
		if r.Context().Err() != nil {
			return
		}
		if json.NewEncoder(w).Encode(v) == nil {
			_ = controller.Flush()
		}
	}
	d, e := s.Recipients(r.Context(), func(d Directory) { send(map[string]any{"type": "progress", "directory": d}) }, refresh)
	if e != nil {
		failure := settingsError(e)
		send(map[string]any{"type": "error", "status": failure.Status, "error": failure.Message, "permission": failure.Permission, "code": failure.Code})
		return
	}
	send(map[string]any{"type": "complete", "directory": d})
}
