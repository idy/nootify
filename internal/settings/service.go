// Package settings implements the local settings API without a TypeScript runtime.
// Authentication, same-origin enforcement and local-owner access are supplied by the HTTP host.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/idy/nootify/internal/privatepath"
	"github.com/idy/nootify/internal/storage"
)

type Options struct {
	Store *storage.Store
	// Editable controls public page affordances and login-code redaction. The host still enforces mutation authorization.
	Editable           func(*http.Request) bool
	Version, MCPConfig string
	Report             func(map[string]any)
	Core               func(context.Context, string, any) (any, error)
	Agents             func() (any, error)
	SetAgent           func(string, bool) (any, error)
	// Env nil uses the process environment. An empty map isolates tests from host credentials.
	Env                         map[string]string
	HTTPClient                  *http.Client
	APIBaseURL, RegistrationURL string
	Verify                      func(context.Context, Credentials) error
	QR                          func(string, int) (string, error)
	Reveal                      func(context.Context, string) error
	Now                         func() time.Time
	Wait                        func(context.Context, time.Duration) error
}
type Service struct {
	options                  Options
	writes                   sync.Mutex
	mu                       sync.Mutex
	lastExport               string
	client                   *http.Client
	apiBase, registrationURL string
	env                      map[string]string
	qr                       func(string, int) (string, error)
	now                      func() time.Time
	apiMu                    sync.Mutex
	currentAPI               *larkAPI
	cache                    *directoryCache
	refresh                  uint64
	registration             registration
	ctx                      context.Context
	cancel                   context.CancelFunc
}

func New(o Options) (*Service, error) {
	if o.Store == nil {
		return nil, errors.New("settings requires a state store")
	}
	client := o.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	clone := *client
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	s := &Service{options: o, client: &clone, apiBase: o.APIBaseURL, registrationURL: o.RegistrationURL, env: o.Env, qr: o.QR, now: o.Now}
	if s.apiBase == "" {
		s.apiBase = "https://open.feishu.cn"
	}
	if s.registrationURL == "" {
		s.registrationURL = "https://accounts.feishu.cn/oauth/v1/app/registration"
	}
	if s.env == nil {
		s.env = envMap()
	}
	if s.qr == nil {
		s.qr = makeQR
	}
	if s.now == nil {
		s.now = time.Now
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.registration.page = RegistrationPage{Status: "idle"}
	s.cache = &directoryCache{path: filepath.Join(o.Store.Directory, "lark-directory-cache.json"), now: s.now}
	return s, nil
}
func (s *Service) Close() error {
	s.cancel()
	s.registration.mu.Lock()
	if s.registration.cancel != nil {
		s.registration.cancel()
	}
	s.registration.mu.Unlock()
	s.registration.wg.Wait()
	s.writes.Lock()
	s.writes.Unlock()
	return nil
}
func (s *Service) report(status, source string) {
	if s.options.Report != nil {
		s.options.Report(map[string]any{"source": source, "status": status})
	}
}
func (s *Service) core(ctx context.Context, method string, p any) (any, error) {
	if s.options.Core == nil {
		return nil, problem(503, "Provider coordinator is not available")
	}
	return s.options.Core(ctx, method, p)
}

type compatibility struct {
	Credentials *struct {
		AppID     string `json:"appId"`
		AppSecret string `json:"appSecret"`
	} `json:"credentials,omitempty"`
	Recipient      string `json:"recipient,omitempty"`
	ProviderID     string `json:"provider_id,omitempty"`
	Source         string `json:"source,omitempty"`
	ConnectionType string `json:"connection_type,omitempty"`
	Status         string `json:"status,omitempty"`
	Groups         int    `json:"groups"`
	MirrorStatus   string `json:"mirror_status,omitempty"`
}

func (c compatibility) credentials() Credentials {
	if c.Credentials == nil {
		return Credentials{}
	}
	return Credentials{c.Credentials.AppID, c.Credentials.AppSecret}
}
func (s *Service) compatibility(ctx context.Context) (compatibility, error) {
	var c compatibility
	if s.options.Core != nil {
		v, e := s.core(ctx, "compatibility.get", nil)
		if e != nil {
			return c, e
		}
		b, e := json.Marshal(v)
		if e == nil {
			e = json.Unmarshal(b, &c)
		}
		return c, e
	}
	creds, source, e := resolveCredentials(s.env, s.options.Store.Setting("lark_app_id"), s.options.Store.Setting("lark_app_secret"), s.options.MCPConfig)
	if e != nil {
		return c, e
	}
	if creds.AppID != "" {
		c.Credentials = &struct {
			AppID     string `json:"appId"`
			AppSecret string `json:"appSecret"`
		}{creds.AppID, creds.AppSecret}
	}
	c.Source = source
	c.Recipient = s.options.Store.Setting("lark_recipient_open_id")
	c.ConnectionType = s.options.Store.Setting("lark_connection_type")
	return c, nil
}
func (s *Service) Page(ctx context.Context) (map[string]any, error) {
	c, e := s.compatibility(ctx)
	if e != nil {
		return nil, e
	}
	creds := c.credentials()
	configured := creds.AppID != "" && creds.AppSecret != ""
	status := c.Status
	if status == "" || !configured {
		status = "disabled"
	}
	ct := c.ConnectionType
	if ct == "" {
		ct = "bot"
	}
	lark := map[string]any{"status": status, "configured": configured, "connection_type": ct, "saved": s.options.Store.Setting("lark_app_id") != "" && s.options.Store.Setting("lark_app_secret") != "", "groups": c.Groups}
	if c.Source != "" {
		lark["source"] = c.Source
	}
	if creds.AppID != "" {
		lark["app_id"] = creds.AppID
	}
	if c.Recipient != "" {
		lark["recipient"] = c.Recipient
	}
	if c.MirrorStatus != "" {
		lark["mirror_status"] = c.MirrorStatus
	}
	s.mu.Lock()
	last := s.lastExport
	s.mu.Unlock()
	p := map[string]any{"version": s.options.Version, "exports_dir": s.exportsDir(), "lark": lark}
	if last != "" {
		p["last_export"] = last
	}
	return p, nil
}
func (s *Service) LarkSecret(ctx context.Context) (map[string]any, error) {
	c, e := s.compatibility(ctx)
	if e != nil {
		return nil, e
	}
	v := c.credentials()
	if v.AppID == "" || v.AppSecret == "" {
		return map[string]any{}, nil
	}
	return map[string]any{"app_id": v.AppID, "app_secret": v.AppSecret}, nil
}
func (s *Service) environmentOverride() bool {
	return s.env["LARK_APP_ID"] != "" || s.env["LARK_APP_SECRET"] != ""
}
func (s *Service) configure(ctx context.Context, p map[string]any) error {
	_, e := s.core(ctx, "compatibility.configure", p)
	// Core owns the authoritative credential snapshot, including committed_not_durable.
	// Never roll back a provider mutation based on a transport failure or durability uncertainty.
	s.mu.Lock()
	s.refresh++
	s.mu.Unlock()
	s.cache.clear()
	return e
}
func (s *Service) SaveLark(ctx context.Context, appID, secret, connectionType any) error {
	if _, e := s.CancelRegistration(); e != nil {
		return e
	}
	s.writes.Lock()
	defer s.writes.Unlock()
	if s.environmentOverride() {
		return problem(409, "LARK_APP_ID and LARK_APP_SECRET are set for this process and take precedence")
	}
	id, ok := appID.(string)
	if !ok || !appPattern.MatchString(id) {
		return problem(400, "Expected a Feishu App ID (cli_ and 16 hexadecimal digits)")
	}
	ct := ""
	if connectionType != nil {
		ct, ok = connectionType.(string)
		if !ok || (ct != "bot" && ct != "personal-app") {
			return problem(400, "Expected bot or personal-app connection type")
		}
	}
	c, e := s.compatibility(ctx)
	if e != nil {
		return e
	}
	sec, ok := secret.(string)
	if secret != nil && !ok {
		return problem(400, "Enter the App Secret")
	}
	if sec == "" {
		if c.credentials().AppID == id {
			sec = c.credentials().AppSecret
		} else if s.options.Store.Setting("lark_app_id") == id {
			sec = s.options.Store.Setting("lark_app_secret")
		}
	}
	sec = trim(sec)
	if sec == "" {
		return problem(400, "Enter the App Secret")
	}
	if e = s.verify(ctx, Credentials{id, sec}); e != nil {
		return problem(400, "Could not verify these credentials with Feishu: "+e.Error())
	}
	if ct == "" {
		ct = "bot"
		if c.credentials().AppID == id && c.ConnectionType != "" {
			ct = c.ConnectionType
		}
	}
	return s.configure(ctx, map[string]any{"app_id": id, "app_secret": sec, "connection_type": ct})
}
func (s *Service) ClearLark(ctx context.Context) error {
	if _, e := s.CancelRegistration(); e != nil {
		return e
	}
	s.writes.Lock()
	defer s.writes.Unlock()
	fallback, source, e := resolveCredentials(s.env, "", "", s.options.MCPConfig)
	if e != nil {
		return e
	}
	return s.configure(ctx, map[string]any{"app_id": fallback.AppID, "app_secret": fallback.AppSecret, "clear_saved": true, "source": source})
}
func (s *Service) SetRecipient(ctx context.Context, openID, appID any) error {
	s.writes.Lock()
	defer s.writes.Unlock()
	c, e := s.compatibility(ctx)
	if e != nil {
		return e
	}
	if appID != nil && appID != c.credentials().AppID {
		return problem(409, "Feishu credentials changed; reload the directory")
	}
	id, ok := openID.(string)
	if !ok || !openPattern.MatchString(id) {
		return problem(400, "Expected a Feishu open_id (ou_…)")
	}
	return s.configure(ctx, map[string]any{"recipient_open_id": id})
}
func (s *Service) exportsDir() string { return filepath.Join(s.options.Store.Directory, "exports") }
func (s *Service) Reveal(ctx context.Context) error {
	if e := os.MkdirAll(s.exportsDir(), 0700); e != nil {
		return e
	}
	if e := privatepath.Protect(s.exportsDir(), true); e != nil {
		return e
	}
	s.mu.Lock()
	path := s.lastExport
	s.mu.Unlock()
	if path == "" {
		path = s.exportsDir()
	}
	if s.options.Reveal != nil {
		return s.options.Reveal(ctx, path)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.CommandContext(ctx, "/usr/bin/open", "-R", path)
	case "windows":
		cmd = exec.CommandContext(ctx, "explorer.exe", "/select,", path)
	default:
		info, e := os.Stat(path)
		if e != nil {
			return e
		}
		if !info.IsDir() {
			path = filepath.Dir(path)
		}
		cmd = exec.CommandContext(ctx, "xdg-open", path)
	}
	e := cmd.Run()
	if runtime.GOOS == "windows" {
		var ex *exec.ExitError
		if errors.As(e, &ex) && ex.ExitCode() == 1 {
			return nil
		}
	}
	return e
}
