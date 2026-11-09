package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const maxRecords = 50000
const maxPending = 2048
const maxPeers = 128
const maxPayload = 1 << 20

type Session struct {
	NodeID    string         `json:"node_id"`
	Adapter   string         `json:"adapter"`
	SessionID string         `json:"session_id"`
	Name      string         `json:"name,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

func (s Session) key() string {
	b, _ := json.Marshal([]string{s.NodeID, s.Adapter, s.SessionID})
	return string(b)
}
func (s Session) validate() error {
	if s.NodeID == "" || s.Adapter == "" || s.SessionID == "" || len(s.key()) > 4096 {
		return fault("invalid_argument", "full session identity is required")
	}
	return nil
}

type ContentBlock struct {
	Type     string         `json:"type"`
	Text     string         `json:"text,omitempty"`
	URL      string         `json:"url,omitempty"`
	Children []ContentBlock `json:"children,omitempty"`
}
type Content struct {
	Text   string         `json:"text,omitempty"`
	Blocks []ContentBlock `json:"blocks,omitempty"`
}

func (c Content) Plain() string {
	var b strings.Builder
	b.WriteString(c.Text)
	var walk func([]ContentBlock)
	walk = func(bs []ContentBlock) {
		for _, v := range bs {
			b.WriteString(v.Text)
			walk(v.Children)
			if v.Type == "paragraph" || v.Type == "code" {
				b.WriteByte('\n')
			}
		}
	}
	walk(c.Blocks)
	return strings.TrimSuffix(b.String(), "\n")
}
func (c Content) Validate() error {
	// Reject deep or malformed trees before marshaling or flattening their text.
	var visit func([]ContentBlock, int) error
	visit = func(bs []ContentBlock, d int) error {
		if d > 16 {
			return fault("invalid_argument", "content nesting exceeds limit")
		}
		for _, v := range bs {
			switch v.Type {
			case "paragraph", "text", "code":
			case "link":
				if !strings.HasPrefix(v.URL, "https://") && !strings.HasPrefix(v.URL, "http://") {
					return fault("invalid_argument", "link requires an HTTP URL")
				}
			default:
				return fault("unsupported_content", "unsupported content block")
			}
			if err := visit(v.Children, d+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := visit(c.Blocks, 0); err != nil {
		return err
	}
	b, err := json.Marshal(c)
	if err != nil || len(b) > maxPayload || strings.TrimSpace(c.Plain()) == "" {
		return fault("invalid_argument", "content is empty or too large")
	}
	return nil
}

type MessageRef struct {
	OriginNodeID string `json:"origin_node_id"`
	ProviderID   string `json:"provider_id"`
	MessageID    string `json:"message_id"`
	// ThreadID is return-path context, not part of the message identity/key.
	ThreadID string `json:"thread_id,omitempty"`
}

func (m MessageRef) key() string {
	b, _ := json.Marshal([]string{m.OriginNodeID, m.ProviderID, m.MessageID})
	return string(b)
}
func (m MessageRef) valid() bool {
	return m.OriginNodeID != "" && m.ProviderID != "" && m.MessageID != ""
}

type Binding struct {
	ProviderID         string  `json:"provider_id"`
	Session            Session `json:"session"`
	Created            bool    `json:"created"`
	ChatID             string  `json:"chat_id,omitempty"`
	ThreadID           string  `json:"thread_id,omitempty"`
	SenderID           string  `json:"sender_open_id,omitempty"`
	Deleted            bool    `json:"deleted,omitempty"`
	DeletePending      bool    `json:"delete_pending,omitempty"`
	ResourceNodeID     string  `json:"resource_origin_node_id,omitempty"`
	ResourceProviderID string  `json:"resource_provider_id,omitempty"`
	// Aliases retain legacy chats targeting this session. They are leaf bindings,
	// each with its own provider, sender and announcement metadata.
	Aliases             []Binding `json:"aliases,omitempty"`
	Legacy              bool      `json:"legacy,omitempty"`
	LegacyHost          string    `json:"legacy_host,omitempty"`
	PreserveDescription bool      `json:"preserve_description,omitempty"`
	HistoryStart        int64     `json:"history_start,omitempty"`
}
type SendResult struct {
	Message   MessageRef `json:"message"`
	ChatID    string     `json:"chat_id,omitempty"`
	MessageID string     `json:"message_id"`
}
type ProviderConfig struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Enabled    bool   `json:"enabled"`
	AppID      string `json:"app_id,omitempty"`
	AppSecret  string `json:"app_secret,omitempty"`
	Recipient  string `json:"recipient_open_id,omitempty"`
	Address    string `json:"address,omitempty"`
	Token      string `json:"token,omitempty"`
	TLS        bool   `json:"tls,omitempty"`
	ServerName string `json:"server_name,omitempty"`
}
type ProviderSummary struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Enabled    bool   `json:"enabled"`
	Status     string `json:"status"`
	Error      string `json:"error,omitempty"`
	AppID      string `json:"app_id,omitempty"`
	Recipient  string `json:"recipient_open_id,omitempty"`
	Address    string `json:"address,omitempty"`
	TLS        bool   `json:"tls,omitempty"`
	ServerName string `json:"server_name,omitempty"`
	SecretSet  bool   `json:"secret_set"`
	TokenSet   bool   `json:"token_set"`
}
type RemoteConfig struct {
	Enabled  bool   `json:"enabled"`
	Listen   string `json:"listen"`
	Token    string `json:"token,omitempty"`
	CertFile string `json:"tls_cert_file,omitempty"`
	KeyFile  string `json:"tls_key_file,omitempty"`
}
type Peer struct {
	NodeID      string   `json:"node_id"`
	Name        string   `json:"name,omitempty"`
	ConnectedAt string   `json:"connected_at"`
	Pending     []string `json:"pending_ids"`
	// Cursor is the last broadcast copied into this peer's bounded window (or
	// skipped because it was deleted/visited). Later events remain in the ledger.
	Cursor  uint64 `json:"broadcast_cursor,omitempty"`
	LastAck string `json:"last_ack,omitempty"`
	// PublicKey pins the independently proven subscription identity. An empty
	// legacy pin must be approved over the private local management bridge.
	PublicKey string `json:"public_key,omitempty"`
}
type RemoteSummary struct {
	Enabled  bool          `json:"enabled"`
	Listen   string        `json:"listen"`
	Status   string        `json:"status"`
	TLS      bool          `json:"tls"`
	TokenSet bool          `json:"token_set"`
	CertFile string        `json:"tls_cert_file,omitempty"`
	KeyFile  string        `json:"tls_key_file,omitempty"`
	Peers    []PeerSummary `json:"peers"`
}
type PeerSummary struct {
	Connected      bool   `json:"connected"`
	NodeID         string `json:"node_id"`
	Name           string `json:"name,omitempty"`
	ConnectedAt    string `json:"connected_at"`
	Pending        int    `json:"pending"`
	LastAck        string `json:"last_ack,omitempty"`
	PublicKey      string `json:"public_key,omitempty"`
	IdentityStatus string `json:"identity_status"`
}
type Event struct {
	ID       string     `json:"event_id"`
	Session  Session    `json:"session"`
	Message  MessageRef `json:"message"`
	Content  Content    `json:"content"`
	Visited  []string   `json:"visited_nodes"`
	Hops     uint32     `json:"hops_remaining"`
	SenderID string     `json:"sender_id,omitempty"`
	ChatID   string     `json:"chat_id,omitempty"`
	// SourceCreatedAt is retained by the ingress node for history deduplication.
	// Relays do not need it: only the source's per-chat cursor covers history.
	SourceCreatedAt int64    `json:"source_created_at,omitempty"`
	Cancellation    *Binding `json:"cancellation,omitempty"`
}
type EventRecord struct {
	Sequence uint64 `json:"broadcast_sequence,omitempty"`
	Event    Event  `json:"event"`
	Outcome  string `json:"outcome"`
}
type Delivery struct {
	ID            string `json:"delivery_id"`
	EventID       string `json:"event_id"`
	Status        string `json:"status"`
	Transport     string `json:"transport_status,omitempty"`
	Error         string `json:"error,omitempty"`
	InboxQueuedAt int64  `json:"inbox_queued_at,omitempty"`
}
type ReferenceRecord struct {
	Message             MessageRef `json:"message"`
	Routes              []string   `json:"routes,omitempty"`
	AcknowledgedAt      string     `json:"acknowledged_at,omitempty"`
	InboxState          string     `json:"inbox_state,omitempty"`
	InboxNodeID         string     `json:"inbox_node_id,omitempty"`
	InboxUpdatedAt      int64      `json:"inbox_updated_at,omitempty"`
	InboxReleasedRoutes []string   `json:"inbox_released_routes,omitempty"`
	InboxReleaseCursor  string     `json:"inbox_release_cursor,omitempty"`
	InboxCanceled       bool       `json:"inbox_canceled,omitempty"`
	InboxCancelPending  bool       `json:"inbox_cancel_pending,omitempty"`
}
type Operation struct {
	State       string          `json:"state"`
	Fingerprint string          `json:"fingerprint"`
	Result      json.RawMessage `json:"result,omitempty"`
	RequestID   string          `json:"request_id,omitempty"`
	Failure     *rpcError       `json:"failure,omitempty"`
}
type rpcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string  { return e.Message }
func fault(code, msg string) error { return &rpcError{code, msg} }
func publicError(err error) *rpcError {
	var committed *committedStateError
	if errors.As(err, &committed) {
		return &rpcError{Code: "committed_not_durable", Message: "state mutation committed; filesystem durability was not confirmed"}
	}
	if rejection, ok := rejectionPublicError(err); ok {
		return rejection
	}
	var e *rpcError
	if errors.As(err, &e) {
		return e
	}
	return &rpcError{"unavailable", "operation failed; retry when the provider is available"}
}
func uid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:])
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func contains(v []string, s string) bool {
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
}

// Router selects provider bindings and owns durable per-node subscriptions.
// A downstream Confirm affects only that node's pending queue.
type Router interface {
	Ensure(context.Context, string, Session) (Binding, error)
	GetMetadata(context.Context, string, Session) (map[string]any, error)
	SetMetadata(context.Context, string, Session, map[string]any) (map[string]any, error)
	Delete(context.Context, string, Session) error
	Send(context.Context, string, Session, Content, string) (SendResult, error)
	Reply(context.Context, MessageRef, Content, string) (SendResult, error)
	Ack(context.Context, MessageRef) (map[string]any, error)
	Subscribe(context.Context, string, string) (*Subscription, error)
}

// Bot is the common Feishu/Remote notification API. Subscribe blocks while
// receiving events; returning an error from the callback refuses ingestion.
// Provider resources stay in the binding rather than becoming business IDs.
type EventHandler func(context.Context, Event) error
type Bot interface {
	Ensure(context.Context, Session) (Binding, error)
	GetMetadata(context.Context, Binding) (map[string]any, error)
	SetMetadata(context.Context, Binding, map[string]any) (map[string]any, error)
	Delete(context.Context, Binding) error
	Send(context.Context, Binding, Content, string) (SendResult, error)
	Reply(context.Context, MessageRef, Content, string) (SendResult, error)
	Ack(context.Context, MessageRef) error
	Subscribe(context.Context, EventHandler) error
	Close() error
}

// Provider is retained as an alias for internal routing maps.
type Provider = Bot
