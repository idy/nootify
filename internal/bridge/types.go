// Package bridge discovers selected local agent sessions and delivers user input
// without starting, resuming, unarchiving, or approving an agent conversation.
package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"sync"

	"github.com/idy/nootify/internal/storage"
)

type Options struct {
	Store      *storage.Store
	Home       string
	Port       int
	Executable string
	Report     func(map[string]any)
}
type PublicSession struct {
	SessionID    string `json:"session_id"`
	HostID       string `json:"host_id"`
	Adapter      string `json:"adapter"`
	SessionName  string `json:"session_name"`
	Availability string `json:"availability,omitempty"`
	LastSeen     string `json:"last_seen,omitempty"`
	LastResult   string `json:"last_result,omitempty"`
}
type sessionRecord struct {
	PublicSession
	SocketPath  string `json:"socket_path,omitempty"`
	SocketToken string `json:"socket_token,omitempty"`
}
type BackendConnection struct {
	URL       string `json:"url"`
	Token     string `json:"token,omitempty"`
	Username  string `json:"username,omitempty"`
	Password  string `json:"password,omitempty"`
	Directory string `json:"directory,omitempty"`
}
type DeliveryResult struct {
	Status string `json:"status"`
}

// DeliveryError distinguishes proven pre-input failures from ambiguous outcomes.
// A dispatcher must never automatically retry Uncertain deliveries.
type DeliveryError struct {
	Message   string
	Reason    string
	Status    int
	Retryable bool
	Uncertain bool
}

func (e *DeliveryError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Reason
}
func retry(message string) *DeliveryError {
	return &DeliveryError{Message: message, Reason: "backend_unavailable", Retryable: true, Status: 503}
}
func uncertain(message string) *DeliveryError {
	return &DeliveryError{Message: message, Reason: "delivery_unconfirmed", Uncertain: true, Status: 502}
}
func unavailable(reason string) *DeliveryError { return &DeliveryError{Reason: reason, Status: 409} }
func httpError(status int, message string) *DeliveryError {
	return &DeliveryError{Message: message, Reason: "delivery_failed", Status: status}
}

// Message contains the complete provider-owned message reference, including any
// opaque return-route fields. It must not be reconstructed from its three IDs.
type InboxDelivery struct {
	Adapter      string         `json:"adapter"`
	SessionID    string         `json:"session_id"`
	Message      map[string]any `json:"message,omitempty"`
	MessageID    string         `json:"message_id,omitempty"`
	ChatID       string         `json:"chat_id,omitempty"`
	SenderOpenID string         `json:"sender_open_id,omitempty"`
	ThreadID     string         `json:"thread_id,omitempty"`
	SessionName  string         `json:"session_name,omitempty"`
	CreatedAt    string         `json:"created_at,omitempty"`
	// Extra retains legacy delivery metadata that this package does not interpret.
	Extra map[string]any `json:"-"`
}

func (d *InboxDelivery) UnmarshalJSON(raw []byte) error {
	type plain InboxDelivery
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value plain
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	var fields map[string]any
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&fields); err != nil {
		return err
	}
	for _, key := range []string{"adapter", "session_id", "message", "message_id", "chat_id", "sender_open_id", "thread_id", "session_name", "created_at"} {
		delete(fields, key)
	}
	*d = InboxDelivery(value)
	d.Extra = fields
	return nil
}
func (d InboxDelivery) MarshalJSON() ([]byte, error) {
	type plain InboxDelivery
	raw, err := json.Marshal(plain(d))
	if err != nil {
		return nil, err
	}
	fields := map[string]json.RawMessage{}
	if err = json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	for key, value := range d.Extra {
		if _, exists := fields[key]; !exists {
			encoded, e := json.Marshal(value)
			if e != nil {
				return nil, e
			}
			fields[key] = encoded
		}
	}
	return json.Marshal(fields)
}

type InboxSource struct {
	Channel  string        `json:"channel"`
	Delivery InboxDelivery `json:"delivery"`
}
type InboxOrigin struct {
	Text   string       `json:"text"`
	Source *InboxSource `json:"source,omitempty"`
}
type InboxMessage struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
}
type storedInbox struct {
	InboxMessage
	SessionID string       `json:"session_id"`
	Adapter   string       `json:"adapter"`
	Source    *InboxSource `json:"source,omitempty"`
}
type SessionInbox struct {
	SessionID string         `json:"session_id"`
	Adapter   string         `json:"adapter"`
	Messages  []InboxMessage `json:"messages"`
}
type ProviderInboxSnapshot struct {
	InboxID string         `json:"inbox_id"`
	Message map[string]any `json:"message"`
}
type Service struct {
	options  Options
	host     string
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.RWMutex
	promptMu sync.Mutex
	consumer func(context.Context, map[string]any) error
}

func New(o Options) (*Service, error) {
	if o.Store == nil {
		return nil, errors.New("bridge requires a store")
	}
	if o.Home == "" {
		var err error
		o.Home, err = os.UserHomeDir()
		if err != nil {
			return nil, err
		}
	}
	if o.Executable == "" {
		var err error
		o.Executable, err = os.Executable()
		if err != nil {
			return nil, err
		}
	}
	if o.Port == 0 {
		o.Port = 9417
	}
	if o.Port < 1 || o.Port > 65535 {
		return nil, fmt.Errorf("invalid bridge port")
	}
	if o.Report == nil {
		o.Report = func(map[string]any) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	host, _ := os.Hostname()
	return &Service{options: o, host: host, ctx: ctx, cancel: cancel}, nil
}
func (s *Service) Close() error          { s.cancel(); return nil }
func (s *Service) Handler() http.Handler { return http.HandlerFunc(s.serveHTTP) }
func (s *Service) SetInboxConsumer(f func(context.Context, map[string]any) error) {
	s.mu.Lock()
	s.consumer = f
	s.mu.Unlock()
}

var identifierRE = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func validID(v string) bool { return v != "" && identifierRE.MatchString(v) }
func validAdapter(v string) bool {
	switch v {
	case "claude-code", "claude-desktop", "codex", "opencode", "trae", "workbuddy":
		return true
	}
	return false
}
func polled(v string) bool { return v == "trae" || v == "workbuddy" }
func envPath(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
