// Package network coordinates Nootify's independent embedded Tailscale device,
// its authenticated read-only HTTP ingress, and the core's encrypted transport.
package network

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/idy/nootify/internal/storage"
	"github.com/idy/nootify/native/core"
	"github.com/idy/nootify/native/tailscale"
	"tailscale.com/client/tailscale/apitype"
)

type Options struct {
	Store   *storage.Store
	Handler http.Handler
	Report  func(map[string]any)
	Core    func(context.Context, string, any) (any, error)
}

type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

type embedded interface {
	Start(context.Context) error
	Close() error
	Done() <-chan struct{}
	Err() error
	Status(context.Context) (tailscale.StatusResult, error)
	Login(context.Context) error
	Logout(context.Context) error
	WhoIs(context.Context, string) (*apitype.WhoIsResponse, error)
	Dial(context.Context, string, string) (net.Conn, error)
	Publish(context.Context, int, string) error
	Unpublish(context.Context, int) error
}

type loginState struct {
	Status string `json:"status"`
	URL    string `json:"url,omitempty"`
	Error  string `json:"error,omitempty"`
}
type pageState struct {
	Enabled    bool       `json:"enabled"`
	Status     string     `json:"status"`
	DeviceName string     `json:"deviceName"`
	Account    string     `json:"account,omitempty"`
	Address    string     `json:"address,omitempty"`
	DNSName    string     `json:"dnsName,omitempty"`
	URL        string     `json:"url,omitempty"`
	Sharing    string     `json:"sharing"`
	Error      string     `json:"error,omitempty"`
	Login      loginState `json:"login"`
}

type Service struct {
	options          Options
	op               sync.Mutex
	mu               sync.Mutex
	ctx              context.Context
	cancel           context.CancelFunc
	started, stopped bool
	wg               sync.WaitGroup
	node             embedded      // protected by mu
	proxy            *proxyBackend // serialized by op
	factory          func(tailscale.Config) (embedded, error)
	access           *access
	page             pageState // serialized by op
	checked, retryAt time.Time
	statusFailures   int
	lastOutcome      string
	configured       *bool
	publishedPort    int
	publishedTarget  string
}

func New(options Options) (*Service, error) {
	if options.Store == nil || options.Handler == nil {
		return nil, errors.New("network requires storage and an HTTP handler")
	}
	s := &Service{options: options, access: newAccess(), factory: func(cfg tailscale.Config) (embedded, error) { return tailscale.NewService(cfg) }}
	s.reset()
	s.page.Enabled = options.Store.BoolSetting("tailscale_enabled", false)
	return s, nil
}

func (s *Service) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return &HTTPError{409, "Tailscale settings are stopping"}
	}
	if s.started {
		s.mu.Unlock()
		return nil
	}
	s.started = true
	s.ctx, s.cancel = context.WithCancel(ctx)
	s.wg.Add(1)
	s.mu.Unlock()
	_ = s.Sync(ctx) // An unavailable optional network must not stop the local app.
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-ticker.C:
				_ = s.Sync(s.ctx)
			}
		}
	}()
	return nil
}

func (s *Service) currentNode() embedded { s.mu.Lock(); defer s.mu.Unlock(); return s.node }
func (s *Service) setNode(node embedded) { s.mu.Lock(); s.node = node; s.mu.Unlock() }
func (s *Service) isStopped() bool       { s.mu.Lock(); defer s.mu.Unlock(); return s.stopped }

func (s *Service) Close() error {
	s.mu.Lock()
	if !s.stopped {
		s.stopped = true
		if s.cancel != nil {
			s.cancel()
		}
	}
	node := s.node
	s.mu.Unlock()
	if node != nil {
		_ = node.Close()
	}
	s.op.Lock()
	s.disconnect()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = s.syncCore(ctx)
	cancel()
	s.op.Unlock()
	s.wg.Wait()
	return nil
}

func (s *Service) URL() string { return s.access.URL() }

func (s *Service) Page(ctx context.Context) (map[string]any, error) {
	s.op.Lock()
	defer s.op.Unlock()
	if time.Since(s.checked) > 1500*time.Millisecond && !s.isStopped() {
		_ = s.synchronize(ctx)
	}
	return s.snapshot(), nil
}

func (s *Service) snapshot() map[string]any {
	s.page.URL = s.URL()
	raw, _ := json.Marshal(s.page)
	var result map[string]any
	_ = json.Unmarshal(raw, &result)
	return result
}

func (s *Service) Sync(ctx context.Context) error {
	s.op.Lock()
	defer s.op.Unlock()
	return s.synchronize(ctx)
}

func (s *Service) synchronize(ctx context.Context) error {
	if s.isStopped() {
		return nil
	}
	defer func() { s.checked = time.Now() }()
	if !s.page.Enabled {
		s.disconnect()
		s.reset()
		return s.syncCore(ctx)
	}
	node := s.currentNode()
	if node == nil && time.Now().Before(s.retryAt) {
		return s.syncCore(ctx)
	}
	if node == nil {
		s.page.Status, s.page.Sharing = "starting", "starting"
		proxy, err := s.listenProxy()
		if err != nil {
			s.failure(err)
			return s.syncCore(ctx)
		}
		s.proxy = proxy
		node, err = s.factory(tailscale.Config{StateDir: filepath.Join(s.options.Store.Directory, "tailscale"), Target: proxy.target(), Hostname: "nootify"})
		if err == nil {
			s.setNode(node)
			parent := s.ctx
			if parent == nil {
				parent = ctx
			}
			err = node.Start(parent)
		}
		if err != nil {
			s.disconnect()
			s.failure(err)
			return s.syncCore(ctx)
		}
		if s.isStopped() {
			s.disconnect()
			return nil
		}
	}
	select {
	case <-node.Done():
		err := node.Err()
		if err == nil {
			err = errors.New("embedded_client_stopped")
		}
		s.disconnect()
		s.failure(err)
		return s.syncCore(ctx)
	default:
	}
	status, err := node.Status(ctx)
	if err != nil {
		transient := err.Error() == "busy" || err.Error() == "timeout" || err.Error() == "status_failed" || err.Error() == "embedded_request_timeout" || err.Error() == "embedded_client_busy"
		s.statusFailures++
		if transient && s.statusFailures < 3 {
			return s.syncCore(ctx)
		}
		s.disconnect()
		s.failure(err)
		return s.syncCore(ctx)
	}
	s.statusFailures = 0
	previous := s.URL()
	s.access.publish(status)
	statuses := map[string]string{"Running": "connected", "NeedsLogin": "needs-login", "Stopped": "starting", "Starting": "starting", "NeedsMachineAuth": "needs-approval"}
	s.page.Status = statuses[status.BackendState]
	if s.page.Status == "" {
		s.page.Status = "unavailable"
	}
	s.page.Account, s.page.Address, s.page.DNSName, s.page.DeviceName = "", "", "", "nootify"
	if self := status.Self; self != nil {
		if self.HostName != "" {
			s.page.DeviceName = self.HostName
		}
		if status.BackendState == "Running" {
			s.page.Account = status.User[self.UserID].LoginName
			for _, ip := range self.TailscaleIPs {
				if ip.Unmap().Is4() && s.page.Address == "" {
					s.page.Address = ip.Unmap().String()
				}
			}
			name := strings.TrimSuffix(strings.ToLower(self.DNSName), ".")
			if strings.HasSuffix(name, ".ts.net") {
				s.page.DNSName = name
				s.page.DeviceName = strings.Split(name, ".")[0]
			}
		}
	}
	s.page.Sharing, s.page.Error, s.page.Login = "starting", "", loginState{Status: "idle"}
	if s.URL() != "" {
		s.page.Sharing = "ready"
	}
	if status.BackendState == "NeedsLogin" {
		if url := loginURL(status.AuthURL); url != "" {
			s.page.Login = loginState{Status: "waiting", URL: url}
		}
	}
	if s.URL() != "" && previous != s.URL() {
		s.report(map[string]any{"status": "tailnet_listening", "reason": s.URL()})
	}
	return s.syncCore(ctx)
}

func (s *Service) reset() {
	s.page = pageState{Status: "disabled", DeviceName: "nootify", Sharing: "off", Login: loginState{Status: "idle"}}
	s.statusFailures, s.lastOutcome = 0, ""
}
func (s *Service) report(record map[string]any) {
	raw, _ := json.Marshal(record)
	if string(raw) == s.lastOutcome {
		return
	}
	s.lastOutcome = string(raw)
	if s.options.Report != nil {
		record["source"] = "host"
		s.options.Report(record)
	}
}
func publicError(err error) string {
	if err != nil {
		for _, code := range []string{"embedded_client_missing", "embedded_client_stopped", "embedded_protocol_error", "embedded_request_timeout", "state_locked", "state_unavailable", "listener_failed", "startup_failed", "client_unavailable", "busy", "timeout", "status_failed"} {
			if err.Error() == code {
				return code
			}
		}
	}
	return "embedded_request_failed"
}
func (s *Service) failure(err error) {
	s.access.publish(tailscale.StatusResult{})
	s.page.Status, s.page.Sharing, s.page.Error = "unavailable", "error", publicError(err)
	s.page.Account, s.page.Address, s.page.DNSName = "", "", ""
	s.page.Login = loginState{Status: "idle"}
	s.retryAt = time.Now().Add(30 * time.Second)
	s.report(map[string]any{"status": "tailnet_failed", "error": s.page.Error})
}
func (s *Service) disconnect() {
	node := s.currentNode()
	s.setNode(nil)
	s.statusFailures = 0
	s.access.publish(tailscale.StatusResult{})
	s.page.Sharing = "off"
	if node != nil {
		_ = node.Close()
	}
	if s.proxy != nil {
		s.proxy.close()
		s.proxy = nil
	}
	s.publishedPort, s.publishedTarget = 0, ""
}
func (s *Service) persist(enabled bool) error {
	if err := s.options.Store.Put("settings", "tailscale_enabled", enabled); err != nil {
		return err
	}
	s.page.Enabled = enabled
	return nil
}

func (s *Service) Action(ctx context.Context, action string, enabled *bool) (any, error) {
	s.op.Lock()
	defer s.op.Unlock()
	if s.isStopped() {
		return nil, &HTTPError{409, "Tailscale settings are stopping"}
	}
	switch action {
	case "enable", "cancel":
		value := false
		if action == "enable" {
			if enabled == nil {
				return nil, &HTTPError{400, "Expected a boolean enabled setting"}
			}
			value = *enabled
		}
		if err := s.persist(value); err != nil {
			return nil, err
		}
		s.retryAt = time.Time{}
		_ = s.synchronize(ctx)
		if action == "cancel" {
			return map[string]any{"accepted": true}, nil
		}
		return s.snapshot(), nil
	case "login":
		wasEnabled := s.page.Enabled
		if !wasEnabled {
			if err := s.persist(true); err != nil {
				return nil, err
			}
		}
		s.retryAt = time.Time{}
		_ = s.synchronize(ctx)
		node := s.currentNode()
		if node == nil {
			return loginState{Status: "failed", Error: s.page.Error}, nil
		}
		if s.page.Status == "connected" || (!wasEnabled && s.page.Login.URL != "") {
			return s.page.Login, nil
		}
		s.page.Login = loginState{Status: "starting"}
		if err := node.Login(ctx); err != nil {
			s.page.Login = loginState{Status: "failed", Error: publicError(err)}
		} else {
			_ = s.synchronize(ctx)
		}
		return s.page.Login, nil
	case "logout":
		node := s.currentNode()
		if node == nil {
			return nil, &HTTPError{409, "Enable the Nootify device before signing out"}
		}
		if err := node.Logout(ctx); err != nil {
			return nil, errors.New(publicError(err))
		}
		err := s.persist(false)
		s.disconnect()
		s.reset()
		_ = s.syncCore(ctx)
		return map[string]any{"accepted": true}, err
	default:
		return nil, &HTTPError{400, "Expected a Tailscale action: enable, login, cancel or logout"}
	}
}

func (s *Service) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	node := s.currentNode()
	if node == nil || s.isStopped() {
		return nil, errors.New("Embedded provider transport is unavailable")
	}
	return node.Dial(ctx, network, address)
}

func (s *Service) syncCore(ctx context.Context) error {
	if s.options.Core == nil {
		return nil
	}
	enabled := s.page.Enabled && s.currentNode() != nil
	if s.configured == nil || *s.configured != enabled {
		_, err := s.options.Core(ctx, "transport.configure", map[string]any{"tailnet_enabled": enabled})
		if err != nil {
			if core.PublicError(err).Code == "committed_not_durable" {
				s.configured = &enabled
			}
			s.report(map[string]any{"status": "network_reconciliation_failed", "error": core.PublicError(err).Message})
			return err
		}
		s.configured = &enabled
	}
	if !enabled {
		return nil
	}
	value, err := s.options.Core(ctx, "status", map[string]any{})
	if err != nil {
		return err
	}
	var status struct {
		Remote struct {
			Enabled bool   `json:"enabled"`
			Listen  string `json:"listen"`
		} `json:"remote"`
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &status); err != nil {
		return err
	}
	node := s.currentNode()
	port, target := 0, ""
	if status.Remote.Enabled {
		port, target, err = publicationTarget(status.Remote.Listen)
		if err != nil {
			_ = s.unpublish(ctx, node)
			return err
		}
	}
	if port == s.publishedPort && target == s.publishedTarget {
		return nil
	}
	if err = s.unpublish(ctx, node); err != nil {
		return err
	}
	if port != 0 {
		if err = node.Publish(ctx, port, target); err != nil {
			return err
		}
		s.publishedPort, s.publishedTarget = port, target
	}
	return nil
}
func (s *Service) unpublish(ctx context.Context, node embedded) error {
	if s.publishedPort != 0 && node != nil {
		if err := node.Unpublish(ctx, s.publishedPort); err != nil {
			return err
		}
	}
	s.publishedPort, s.publishedTarget = 0, ""
	return nil
}
func publicationTarget(listen string) (int, string, error) {
	host, rawPort, err := net.SplitHostPort(listen)
	port, parseErr := strconv.Atoi(rawPort)
	bad := errors.New("Remote listener is not reachable through a supported loopback address")
	if err != nil || parseErr != nil || port < 1 || port > 65535 || port == 80 {
		return 0, "", bad
	}
	if host == "localhost" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if host == "::" {
		host = "::1"
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || ip.Zone() != "" || !ip.Unmap().IsLoopback() {
		return 0, "", bad
	}
	return port, net.JoinHostPort(ip.Unmap().String(), strconv.Itoa(port)), nil
}
