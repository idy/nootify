// Package providers connects the notification core directly to local agent
// adapters. No JSON-over-stdio process bridge is involved.
package providers

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/idy/nootify/internal/bridge"
	"github.com/idy/nootify/internal/storage"
	core "github.com/idy/nootify/native/core"
)

type Options struct {
	Store      *storage.Store
	Sessions   *bridge.Service
	Port       int
	Executable string
	Report     func(map[string]any)
	HTTPClient *http.Client
	APIBaseURL string
}
type Credentials struct{ AppID, AppSecret, Recipient, Source string }
type Service struct {
	options              Options
	core                 *core.Core
	store                *core.Store
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	ops                  sync.Mutex
	active               map[string]bool
	wg                   sync.WaitGroup
	draining             bool
	compatID             string
	source               string
	environment          Credentials
	compatConnectionType string
	mirrorPending        bool
	pendingMirror        map[string]any
	pendingScopesApp     string
	mirrorApp            string
	savedCleared         bool
	network              func(context.Context) error
	reconcileMu          sync.Mutex
	legacyMu             sync.Mutex
}

func New(ctx context.Context, o Options) (*Service, error) {
	if o.Store == nil || o.Sessions == nil {
		return nil, errors.New("provider state and session bridge are required")
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &Service{options: o, ctx: ctx, cancel: cancel, compatID: "legacy-feishu", active: map[string]bool{}}
	store, err := core.OpenStore(filepath.Join(o.Store.Directory, "provider-core"))
	if err != nil {
		cancel()
		return nil, err
	}
	s.store = store
	s.core, err = core.NewCore(ctx, store, s.emit)
	if err != nil {
		store.Close()
		cancel()
		return nil, err
	}
	return s, nil
}
func (s *Service) Core() *core.Core                                { return s.core }
func (s *Service) SetNetworkSync(sync func(context.Context) error) { s.network = sync }
func (s *Service) report(value map[string]any) {
	if s.options.Report != nil {
		if _, ok := value["source"]; !ok {
			value["source"] = "providers"
		}
		s.options.Report(value)
	}
}
func (s *Service) raw(ctx context.Context, method string, params any) (any, error) {
	if params == nil {
		params = map[string]any{}
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	result, err := s.core.Handle(ctx, method, raw, true)
	if err != nil {
		return nil, core.PublicError(err)
	}
	return result, nil
}
func (s *Service) Call(ctx context.Context, method string, params any) (any, error) {
	if method == "compatibility.get" {
		s.ops.Lock()
		defer s.ops.Unlock()
		_ = s.repairCompatibilityMirror()
		return s.compatibility(ctx)
	}
	if method == "compatibility.configure" {
		s.ops.Lock()
		defer s.ops.Unlock()
		return s.configureCompatibility(ctx, asMap(params))
	}
	mutation := method == "provider.save" || method == "provider.delete" || method == "provider.default" || method == "config.import" || method == "remote.configure"
	if !mutation {
		return s.raw(ctx, method, params)
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	if err := s.repairCompatibilityMirror(); err != nil {
		return nil, err
	}
	body := asMap(params)
	if method == "config.import" {
		return s.importCompatibility(ctx, body)
	}
	if err := s.checkEnvironmentMutation(ctx, method, body); err != nil {
		return nil, err
	}
	result, err := s.raw(ctx, method, params)
	return s.completeCompatibilityMutation(ctx, result, err)
}
func (s *Service) Start(credentials Credentials) error {
	s.source = credentials.Source
	if err := s.core.Start(); err != nil {
		return err
	}
	migration, err := s.legacyMigration(credentials)
	if err != nil {
		return err
	}
	if migration != nil {
		_, err = s.raw(s.ctx, "migration.import", migration)
		if err != nil && !s.startupCompatibilityWarning(err) {
			return err
		}
	}
	s.ops.Lock()
	err = s.reconcileCredentials(s.ctx, credentials)
	s.ops.Unlock()
	if err != nil && !s.startupCompatibilityWarning(err) {
		return err
	}
	s.options.Sessions.SetInboxConsumer(func(ctx context.Context, message map[string]any) error {
		_, err := s.raw(ctx, "delivery.inbox.consume", map[string]any{"message": message})
		return err
	})
	if err := s.ReconcileInbox(s.ctx); err != nil {
		s.report(map[string]any{"status": "inbox_reconciliation_pending", "error": err.Error()})
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		timer := time.NewTicker(30 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-timer.C:
				if err := s.ReconcileInbox(s.ctx); err != nil {
					s.report(map[string]any{"status": "inbox_reconciliation_pending", "error": err.Error()})
				}
			}
		}
	}()
	return nil
}
func (s *Service) Close() error {
	s.mu.Lock()
	s.draining = true
	s.mu.Unlock()
	s.cancel()
	s.wg.Wait()
	s.core.Close()
	return s.store.Close()
}
func (s *Service) Page(ctx context.Context) (map[string]any, error) {
	v, err := s.raw(ctx, "status", nil)
	if err != nil {
		return nil, err
	}
	return asMap(v), nil
}
func (s *Service) Channel(ctx context.Context) map[string]any {
	page, err := s.Page(ctx)
	if err != nil {
		return map[string]any{"name": "feishu", "configured": false, "groups": 0}
	}
	configured := false
	for _, provider := range listMaps(page["providers"]) {
		if provider["enabled"] == true {
			configured = true
		}
	}
	bindings, _ := s.raw(ctx, "session.list", nil)
	groups := 0
	for _, binding := range listMaps(bindings) {
		if binding["deleted"] == true {
			continue
		}
		if str(binding["chat_id"]) != "" {
			groups++
		}
		for _, alias := range listMaps(binding["aliases"]) {
			if alias["deleted"] != true && str(alias["chat_id"]) != "" {
				groups++
			}
		}
	}
	result := map[string]any{"name": "feishu", "configured": configured, "groups": groups}
	if recipient := s.options.Store.Setting("lark_recipient_open_id"); recipient != "" {
		result["recipient"] = recipient
	}
	return result
}
func (s *Service) ReconcileInbox(ctx context.Context) error {
	s.reconcileMu.Lock()
	defer s.reconcileMu.Unlock()
	pending, before, err := s.options.Sessions.InboxSnapshotWithCutoff()
	if err != nil {
		return err
	}
	result, err := s.raw(ctx, "delivery.inbox.reconcile", map[string]any{"pending": pending, "before": before})
	if err != nil {
		return err
	}
	canceled := listMaps(asMap(result)["canceled"])
	removed, err := s.options.Sessions.DiscardCanceledInbox(ctx, pending, canceled)
	if err != nil {
		return err
	}
	for _, message := range removed {
		if _, err = s.raw(ctx, "delivery.inbox.consume", map[string]any{"message": message}); err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) emit(name string, data any) error {
	if name == "log" {
		s.report(asMap(data))
		return nil
	}
	if name != "delivery" {
		return nil
	}
	delivery := asMap(data)
	id := str(delivery["delivery_id"])
	if id == "" {
		return errors.New("delivery identity is missing")
	}
	s.mu.Lock()
	if s.draining {
		s.mu.Unlock()
		return errors.New("notification service is stopping")
	}
	if s.active[id] {
		s.mu.Unlock()
		return nil
	}
	if len(s.active) >= 100 {
		s.mu.Unlock()
		return errors.New("agent delivery queue is full")
	}
	s.active[id] = true
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		defer func() { s.mu.Lock(); delete(s.active, id); s.mu.Unlock() }()
		s.deliver(delivery)
	}()
	return nil
}
func (s *Service) deliver(delivery map[string]any) {
	session := asMap(delivery["session"])
	message := asMap(delivery["message"])
	adapter, id := str(session["adapter"]), str(session["session_id"])
	source := &bridge.InboxSource{Channel: "provider", Delivery: bridge.InboxDelivery{Adapter: adapter, SessionID: id, Message: message}}
	text := str(delivery["text"])
	if text == "" {
		text = str(asMap(delivery["content"])["text"])
	}
	content := text
	if adapter != "trae" && adapter != "workbuddy" {
		content = s.options.Sessions.ForwardedProviderMessage(source, text)
	}
	result, err := s.options.Sessions.Send(s.ctx, id, content, adapter, &bridge.InboxOrigin{Text: text, Source: source})
	status := "delivered"
	failure := ""
	if err != nil {
		failure = err.Error()
		status = "unconfirmed"
		var de *bridge.DeliveryError
		if errors.As(err, &de) {
			if de.Retryable {
				status = "retryable"
			} else if !de.Uncertain {
				status = "rejected"
			}
		}
	}
	completeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, completeErr := s.raw(completeCtx, "delivery.complete", map[string]any{"delivery_id": delivery["delivery_id"], "status": status, "transport_status": result.Status, "error": failure})
	if completeErr != nil {
		s.report(map[string]any{"status": "delivery_completion_failed", "error": completeErr.Error()})
	}
	s.report(map[string]any{"status": first(result.Status, status), "session_id": id, "message_id": message["message_id"], "provider_id": message["provider_id"]})
}
func str(v any) string { s, _ := v.(string); return s }
func first(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
func asMap(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	var m map[string]any
	switch raw := value.(type) {
	case json.RawMessage:
		_ = json.Unmarshal(raw, &m)
	case []byte:
		_ = json.Unmarshal(raw, &m)
	default:
		b, _ := json.Marshal(value)
		_ = json.Unmarshal(b, &m)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m
}
func listMaps(value any) []map[string]any {
	raw, _ := json.Marshal(value)
	var result []map[string]any
	_ = json.Unmarshal(raw, &result)
	if result == nil {
		return []map[string]any{}
	}
	return result
}
func errorCode(err error) string {
	var e *core.RPCError
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}
func (s *Service) SetTailnetDialer(dial func(context.Context, string, string) (net.Conn, error)) {
	s.core.SetTailnetDialer(dial)
}
