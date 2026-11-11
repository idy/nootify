package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/idy/nootify/internal/storage"
)

func (s *Service) SessionName(id, adapter string) string {
	var p PublicSession
	if ok, _ := s.options.Store.Get("session_observations", adapter+":"+id, &p); ok && p.SessionName != "" {
		return p.SessionName
	}
	var r sessionRecord
	if ok, _ := s.options.Store.Get("sessions", id, &r); ok && r.SessionName != "" {
		return r.SessionName
	}
	return id
}

// List reads only previously observed state. It never contacts any client.
func (s *Service) List() any {
	result := []PublicSession{}
	rows, err := s.options.Store.Rows("session_observations")
	if err != nil {
		s.options.Report(map[string]any{"source": "sessions", "status": "failed", "reason": "session_history_read_failed", "error": err.Error()})
		return result
	}
	for i := len(rows) - 1; i >= 0; i-- {
		var p PublicSession
		if json.Unmarshal(rows[i].Value, &p) == nil && validAdapter(p.Adapter) && validID(p.SessionID) {
			result = append(result, p)
		}
	}
	return result
}
func (s *Service) Send(ctx context.Context, id, content, adapter string, origin *InboxOrigin) (result DeliveryResult, err error) {
	if !validID(id) {
		return result, httpError(400, "Invalid session_id")
	}
	if strings.TrimSpace(content) == "" {
		return result, httpError(400, "Invalid text")
	}
	var saved sessionRecord
	exists, e := s.options.Store.Get("sessions", id, &saved)
	if e != nil {
		return result, retry(e.Error())
	}
	if adapter == "" {
		if exists {
			adapter = saved.Adapter
		} else if strings.HasPrefix(id, "local_") {
			adapter = "claude-desktop"
		} else {
			adapter = "claude-code"
		}
	}
	if !validAdapter(adapter) {
		return result, httpError(400, "Unsupported session adapter")
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.ctx, cancel)
	defer cancel()
	defer stop()
	observed := PublicSession{SessionID: id, Adapter: adapter, HostID: s.host, SessionName: s.SessionName(id, adapter), Availability: "unknown", LastSeen: time.Now().UTC().Format(time.RFC3339Nano)}
	defer func() {
		if err != nil {
			var de *DeliveryError
			if !errors.As(err, &de) {
				de = retry(err.Error())
				err = de
			}
			observed.LastResult = de.Reason
			switch de.Reason {
			case "session_not_local":
				observed.Availability = "missing"
			case "session_archived":
				observed.Availability = "archived"
			case "session_offline":
				observed.Availability = "offline"
			}
		} else {
			observed.LastResult = result.Status
		}
		if e := s.options.Store.Update(func(tx *storage.Tx) error {
			if e := tx.Delete("session_observations", adapter+":"+id); e != nil {
				return e
			}
			if e := tx.Put("session_observations", adapter+":"+id, observed); e != nil {
				return e
			}
			rows, e := tx.Rows("session_observations")
			if e != nil {
				return e
			}
			if len(rows) <= 1000 {
				return nil
			}
			for _, r := range rows[:len(rows)-1000] {
				if e = tx.Delete("session_observations", r.ID); e != nil {
					return e
				}
			}
			return nil
		}); e != nil {
			s.options.Report(map[string]any{"source": "sessions", "status": "failed", "reason": "session_history_save_failed", "session_id": id, "error": e.Error()})
		}
	}()
	if ctx.Err() != nil {
		return result, retry("Bridge is closed or request canceled")
	}
	if polled(adapter) {
		if !exists || saved.Adapter != adapter || saved.HostID != s.host {
			return result, unavailable("session_not_local")
		}
		observed.SessionName = saved.SessionName
		text := "[Nootify: " + saved.SessionName + "]\n" + content
		var source *InboxSource
		if origin != nil {
			text = origin.Text
			source = origin.Source
		}
		return s.queueInbox(adapter, id, text, source)
	}
	if adapter == "codex" || adapter == "opencode" {
		return s.sendExternal(ctx, id, content, adapter, &observed)
	}
	local, e := s.inspectLocal(id, adapter)
	if e != nil {
		return result, e
	}
	if local == nil {
		return result, unavailable("session_not_local")
	}
	observed.SessionName = local.SessionName
	observed.Availability = local.Availability
	if local.Availability != "active" || local.path == "" {
		switch local.Availability {
		case "archived":
			return result, unavailable("session_archived")
		case "unknown":
			return result, unavailable("archive_unknown")
		default:
			return result, unavailable("session_offline")
		}
	}
	token := ""
	if saved.Adapter == adapter && saved.SocketPath == local.path {
		token = saved.SocketToken
	}
	return writeInbox(ctx, local.path, "[Nootify: "+local.SessionName+"]\n"+content, token, local.pid, 5*time.Second)
}
func (s *Service) register(id string, r sessionRecord) error {
	if !validID(id) || !validAdapter(r.Adapter) || strings.TrimSpace(r.SessionName) == "" {
		return httpError(400, "Invalid session registration")
	}
	if r.Adapter == "claude-code" || r.Adapter == "claude-desktop" {
		if err := checkSocket(r.SocketPath); err != nil {
			return httpError(400, err.Error())
		}
	}
	r.SessionID = id
	r.HostID = s.host
	r.Availability = ""
	r.LastSeen = ""
	r.LastResult = ""
	err := s.options.Store.Update(func(tx *storage.Tx) error {
		var old sessionRecord
		ok, e := tx.Get("sessions", id, &old)
		if e != nil {
			return e
		}
		if ok && old.Adapter != r.Adapter && (polled(old.Adapter) || polled(r.Adapter)) {
			return httpError(409, "This session ID belongs to another adapter")
		}
		return tx.Put("sessions", id, r)
	})
	if err == nil {
		s.options.Report(map[string]any{"source": "sessions", "status": "registered", "session_id": id, "session_name": r.SessionName})
	}
	return err
}
func (s *Service) RegisterPolledSession(adapter, id, name string) error {
	if !polled(adapter) {
		return nil
	}
	if !validID(id) || strings.TrimSpace(name) == "" {
		return httpError(400, "Invalid session registration")
	}
	return s.options.Store.Update(func(tx *storage.Tx) error {
		var r sessionRecord
		ok, err := tx.Get("sessions", id, &r)
		if err != nil {
			return err
		}
		if ok && r.Adapter != adapter {
			return httpError(409, "This session ID belongs to another adapter")
		}
		if !ok {
			r = sessionRecord{PublicSession: PublicSession{SessionID: id, Adapter: adapter, SessionName: name}}
		}
		r.HostID = s.host
		return tx.Put("sessions", id, r)
	})
}
func (s *Service) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var result any
	var err error
	path := strings.Trim(r.URL.Path, "/")
	parts := strings.Split(path, "/")
	// Authentication is owned by the enclosing HTTP service.
	switch {
	case r.URL.Path == "/v1/sessions" && r.Method == http.MethodGet:
		result = s.List()
	case r.URL.Path == "/v1/agents" && r.Method == http.MethodGet:
		result, err = s.Agents()
	case len(parts) == 3 && parts[0] == "v1" && parts[1] == "agents" && r.Method == http.MethodPut:
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		err = readBody(w, r, &body)
		if err == nil {
			if body.Enabled == nil {
				err = httpError(400, "enabled must be true or false")
			} else {
				result, err = s.SetAgent(parts[2], *body.Enabled)
			}
		}
	case len(parts) == 3 && parts[0] == "v1" && parts[1] == "backends" && r.Method == http.MethodPut:
		adapter := parts[2]
		if adapter != "codex" && adapter != "opencode" {
			err = httpError(404, "Unknown backend")
			break
		}
		var connection BackendConnection
		err = readBody(w, r, &connection)
		if err == nil {
			_, err = localEndpoint(connection, adapter)
		}
		if err == nil {
			err = s.options.Store.Put("backends", adapter, connection)
			result = map[string]any{"adapter": adapter, "configured": true}
		}
	case len(parts) >= 3 && parts[0] == "v1" && parts[1] == "sessions":
		id, e := url.PathUnescape(parts[2])
		if e != nil || !validID(id) {
			err = httpError(400, "Invalid session_id")
			break
		}
		switch {
		case len(parts) == 3 && r.Method == http.MethodPut:
			var record sessionRecord
			err = readBody(w, r, &record)
			if err == nil {
				err = s.register(id, record)
				record.SessionID = id
				record.HostID = s.host
				result = PublicSession{SessionID: id, HostID: s.host, Adapter: record.Adapter, SessionName: record.SessionName}
			}
		case len(parts) == 4 && parts[3] == "messages" && r.Method == http.MethodPost:
			var body struct {
				Text    string `json:"text"`
				Adapter string `json:"adapter"`
			}
			err = readBody(w, r, &body)
			if err == nil {
				result, err = s.Send(r.Context(), id, body.Text, body.Adapter, nil)
			}
		case (len(parts) == 4 || len(parts) == 6 && parts[5] == "ack") && parts[3] == "inbox" && r.Method == http.MethodPost:
			var body struct {
				Adapter string `json:"adapter"`
			}
			err = readBody(w, r, &body)
			if err == nil && !polled(body.Adapter) {
				err = httpError(400, "Inbox polling is supported for trae and workbuddy")
			}
			if err == nil {
				if len(parts) == 6 {
					if !validID(parts[4]) {
						err = httpError(400, "Invalid message_id")
					} else {
						result, err = s.ackInbox(r.Context(), body.Adapter, id, parts[4])
					}
				} else {
					result, err = s.inbox(body.Adapter, id)
				}
			}
		default:
			err = httpError(404, "Not found")
		}
	default:
		err = httpError(404, "Not found")
	}
	if err != nil {
		status := 500
		reason := ""
		var de *DeliveryError
		if errors.As(err, &de) {
			if de.Status != 0 {
				status = de.Status
			}
			reason = de.Reason
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "reason": reason})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}
func readBody(w http.ResponseWriter, r *http.Request, v any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return httpError(400, "Expected a JSON object")
	}
	if len(raw) == 0 || raw[0] != '{' {
		return httpError(400, "Expected a JSON object")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return httpError(400, fmt.Sprintf("Invalid request: %v", err))
	}
	return nil
}
