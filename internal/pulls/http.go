package pulls

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }
func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func jsonFailure(w http.ResponseWriter, err error) {
	status := 500
	var failure *HTTPError
	if errors.As(err, &failure) {
		status = failure.Status
	}
	jsonResponse(w, status, map[string]any{"error": safeError(err)})
}
func smallJSON(r *http.Request) (map[string]json.RawMessage, error) {
	data, e := io.ReadAll(io.LimitReader(r.Body, 4097))
	if e != nil {
		return nil, e
	}
	if len(data) > 4096 {
		return nil, &HTTPError{413, "Request body is too large"}
	}
	var value map[string]json.RawMessage
	if !json.Valid(data) {
		return nil, &HTTPError{400, "Invalid JSON"}
	}
	if json.Unmarshal(data, &value) != nil || value == nil {
		return nil, &HTTPError{400, "Expected a JSON object"}
	}
	return value, nil
}

// repositoryInput retains String(body.repository)'s successful coercion of singleton arrays.
// Other non-string JSON values cannot form an owner/name repository.
func repositoryInput(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	for {
		switch entry := value.(type) {
		case string:
			return entry
		case []any:
			if len(entry) != 1 {
				return ""
			}
			value = entry[0]
		default:
			return ""
		}
	}
}

// UIHandler implements the existing UI routes, including their custom-header CSRF boundary.
// Owner/tailnet authentication is provided by the enclosing UI server.
func (s *Service) UIHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if r.Method == http.MethodGet && (path == "/ui/api/pulls" || path == "/v1/pulls") {
			jsonResponse(w, 200, s.Snapshot())
			return
		}
		if r.Method == http.MethodGet && (path == "/ui/api/repos" || path == "/v1/repos") {
			jsonResponse(w, 200, s.Repositories())
			return
		}
		uiPost := r.Method == http.MethodPost && (path == "/ui/api/pulls/refresh" || path == "/ui/api/repos")
		if uiPost && r.Header.Get("x-nootify-ui") != "1" {
			jsonResponse(w, 403, map[string]any{"error": "Missing UI request header"})
			return
		}
		if r.Method == http.MethodPost && (path == "/ui/api/pulls/refresh" || path == "/v1/pulls/refresh") {
			s.Refresh()
			if path == "/v1/pulls/refresh" {
				jsonResponse(w, 202, s.Snapshot())
			} else {
				jsonResponse(w, 202, map[string]any{"accepted": true})
			}
			return
		}
		repo := ""
		repoRoute := false
		if r.Method == http.MethodPut && strings.HasPrefix(path, "/v1/repos/") {
			parts := strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/v1/repos/"), "/")
			if len(parts) == 2 {
				owner, e1 := url.PathUnescape(parts[0])
				name, e2 := url.PathUnescape(parts[1])
				if e1 == nil && e2 == nil {
					repo = owner + "/" + name
					repoRoute = true
				}
			}
		}
		if (uiPost && path == "/ui/api/repos") || repoRoute {
			body, e := smallJSON(r)
			if e != nil {
				jsonFailure(w, e)
				return
			}
			if !repoRoute {
				repo = repositoryInput(body["repository"])
			}
			if !repositoryName(repo) {
				jsonFailure(w, &HTTPError{400, "Expected an owner/name GitHub repository"})
				return
			}
			followRaw, ok := body["follow"]
			if !ok {
				jsonFailure(w, &HTTPError{400, "follow must be true, false or null"})
				return
			}
			var follow *bool
			if string(followRaw) != "null" {
				var b bool
				if json.Unmarshal(followRaw, &b) != nil {
					jsonFailure(w, &HTTPError{400, "follow must be true, false or null"})
					return
				}
				follow = &b
			}
			entry, e := s.SetChoice(repo, follow)
			if e != nil {
				jsonFailure(w, e)
				return
			}
			jsonResponse(w, 200, entry)
			return
		}
		http.NotFound(w, r)
	})
}
