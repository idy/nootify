// Package host owns the single Go HTTP service and all background modules.
package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/idy/nootify/internal/bridge"
	"github.com/idy/nootify/internal/events"
	"github.com/idy/nootify/internal/httpx"
	"github.com/idy/nootify/internal/providers"
	"github.com/idy/nootify/internal/pulls"
	"github.com/idy/nootify/internal/settings"
	"github.com/idy/nootify/internal/storage"
	"github.com/idy/nootify/internal/webui"
)

type Options struct {
	StateDir, Home, MCPConfig, Version, Executable string
	Port                                           int
	Assets                                         fs.FS
	Output                                         io.Writer
	RefreshPrompts                                 bool
}
type Server struct {
	options   Options
	ctx       context.Context
	cancel    context.CancelFunc
	listener  net.Listener
	http      *http.Server
	owner     *webui.Owner
	store     *storage.Store
	logs      *events.Log
	bridge    *bridge.Service
	providers *providers.Service
	pulls     *pulls.Service
	auth      *pulls.Auth
	settings  *settings.Service
	done      chan struct{}
	once      sync.Once
	wg        sync.WaitGroup
	closeErr  error
	serveMu   sync.Mutex
	serveErr  error
	admitMu   sync.Mutex
	handlers  sync.WaitGroup
	stopping  bool
}

func New(parent context.Context, o Options) (server *Server, err error) {
	if o.Port < 0 || o.Port > 65535 {
		return nil, errors.New("invalid service port")
	}
	if o.Assets == nil {
		return nil, errors.New("embedded UI assets are required")
	}
	if o.Home == "" {
		o.Home = os.Getenv("NOOTIFY_HOME")
	}
	if o.Home == "" {
		o.Home, _ = os.UserHomeDir()
	}
	if o.Executable == "" {
		o.Executable, _ = os.Executable()
	}
	listener, err := listenLAN(o.Port)
	if err != nil {
		return nil, err
	}
	o.Port = listener.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithCancel(parent)
	s := &Server{options: o, listener: listener, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	defer func() {
		if err != nil {
			_ = s.Close()
		}
	}()
	s.store, err = storage.Open(o.StateDir)
	if err != nil {
		return nil, err
	}
	s.logs, err = events.Open(s.store.Directory, o.Output)
	if err != nil {
		return nil, err
	}
	s.bridge, err = bridge.New(bridge.Options{Store: s.store, Home: o.Home, Port: o.Port, Executable: o.Executable, Report: s.logs.Report})
	if err != nil {
		return nil, err
	}
	s.providers, err = providers.New(ctx, providers.Options{Store: s.store, Sessions: s.bridge, Port: o.Port, Executable: o.Executable, Report: s.logs.Report})
	if err != nil {
		return nil, err
	}
	s.pulls, err = pulls.New(pulls.Options{StateDir: s.store.Directory, Home: o.Home, Token: func() string { return s.store.Setting("github_token") }, Report: s.logs.Report})
	if err != nil {
		return nil, err
	}
	s.auth = pulls.NewAuth(pulls.AuthOptions{GetToken: func() string { return s.store.Setting("github_token") }, SetToken: func(token string) error {
		var value any = token
		if token == "" {
			value = nil
		}
		return s.store.SetSettings(map[string]any{"github_token": value})
	}, Report: s.logs.Report, Changed: s.pulls.RefreshSoon, StateDir: s.store.Directory})
	s.owner = webui.NewOwner(s.store.Token)
	s.settings, err = settings.New(settings.Options{Store: s.store, Version: o.Version, MCPConfig: o.MCPConfig, Report: s.logs.Report, Core: s.providers.Call, Editable: uiEditable, Agents: func() (any, error) { return s.bridge.Agents() }, SetAgent: func(id string, enabled bool) (any, error) { return s.bridge.SetAgent(id, enabled) }, PullPreferences: func() (any, error) { return s.pulls.Preferences() }, RestorePulls: func(value any) error {
		raw, e := json.Marshal(value)
		if e != nil {
			return e
		}
		var preferences pulls.Preferences
		if e = json.Unmarshal(raw, &preferences); e != nil {
			return e
		}
		return s.pulls.Restore(preferences)
	}, GitHub: func(ctx context.Context) (any, error) { return s.auth.Settings(ctx), nil }, GitHubAction: func(ctx context.Context, action string) (any, error) {
		switch action {
		case "start":
			return s.auth.Start(s.ctx), nil
		case "cancel":
			return s.auth.Cancel(), nil
		case "sign-out":
			return map[string]bool{"accepted": true}, s.auth.SignOut()
		}
		return nil, httpx.Fail(400, "Invalid GitHub login action")
	}})
	if err != nil {
		return nil, err
	}
	credentials, source, err := settings.ResolveCredentials(s.store, o.MCPConfig)
	if err != nil {
		return nil, err
	}
	recipient := s.store.Setting("lark_recipient_open_id")
	if recipient == "" {
		recipient = os.Getenv("LARK_NOTIFY_OPEN_ID")
	}
	if err = s.providers.Start(providers.Credentials{AppID: credentials.AppID, AppSecret: credentials.AppSecret, Recipient: recipient, Source: source}); err != nil {
		return nil, err
	}
	if o.RefreshPrompts {
		if agents, listErr := s.bridge.Agents(); listErr == nil {
			for _, agent := range agents {
				if agent.Injected && agent.Status != "conflict" && agent.Status != "error" {
					if _, updateErr := s.bridge.SetAgent(agent.Agent, true); updateErr != nil {
						s.logs.Report(map[string]any{"source": "agents", "status": "prompt_update_failed", "error": updateErr.Error()})
					}
				}
			}
		}
	}
	if err = s.pulls.Start(ctx); err != nil {
		return nil, err
	}
	s.http = &http.Server{Handler: http.HandlerFunc(s.ServeHTTP), ConnContext: s.owner.ConnContext, ConnState: s.owner.ConnState, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		e := s.http.Serve(listener)
		if !errors.Is(e, http.ErrServerClosed) {
			s.serveMu.Lock()
			s.serveErr = e
			s.serveMu.Unlock()
			s.cancel()
		}
	}()
	s.wg.Add(1)
	go s.enrollment()
	s.logs.Report(map[string]any{"status": "ready", "source": "host", "reason": "Go service listening at " + s.URL()})
	go func() { <-ctx.Done(); _ = s.Close() }()
	return s, nil
}
func (s *Server) URL() string {
	return "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(s.options.Port))
}
func (s *Server) State() *storage.Store { return s.store }
func (s *Server) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		_ = s.Close()
	case <-s.done:
	}
	s.serveMu.Lock()
	defer s.serveMu.Unlock()
	if s.serveErr != nil {
		return s.serveErr
	}
	return s.closeErr
}
func (s *Server) Close() error {
	s.once.Do(func() {
		s.admitMu.Lock()
		s.stopping = true
		s.admitMu.Unlock()
		s.cancel()
		var failures []error
		attempt := func(err error) {
			if err != nil {
				failures = append(failures, err)
			}
		}
		if s.http != nil {
			attempt(s.http.Close())
		} else if s.listener != nil {
			attempt(s.listener.Close())
		}
		s.handlers.Wait()
		if s.settings != nil {
			s.settings.Close()
		}
		if s.auth != nil {
			attempt(s.auth.Close())
		}
		if s.pulls != nil {
			attempt(s.pulls.Close())
		}
		s.wg.Wait()
		if s.providers != nil {
			attempt(s.providers.Close())
		}
		if s.bridge != nil {
			attempt(s.bridge.Close())
		}
		if s.store != nil {
			attempt(s.store.Close())
		}
		s.closeErr = errors.Join(failures...)
		close(s.done)
	})
	return s.closeErr
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.admitMu.Lock()
	if s.stopping {
		s.admitMu.Unlock()
		httpx.WriteError(w, httpx.Fail(503, "Nootify is stopping"))
		return
	}
	s.handlers.Add(1)
	s.admitMu.Unlock()
	defer s.handlers.Done()
	remote := !localPeer(r)
	host := strings.ToLower(r.Host)
	if !lanPeer(r) || !s.allowedHost(r) {
		httpx.WriteError(w, httpx.Fail(403, "Only this computer and its LAN addresses are accepted"))
		return
	}
	pageNavigation := r.Method == "GET" && r.URL.Path == "/" && r.Header.Get("sec-fetch-dest") == "document"
	if site := r.Header.Get("sec-fetch-site"); !pageNavigation && site != "" && site != "same-origin" && site != "none" {
		httpx.WriteError(w, httpx.Fail(403, "Cross-site requests are not accepted"))
		return
	}
	if origin := r.Header.Get("origin"); origin != "" && origin != "http://"+host {
		httpx.WriteError(w, httpx.Fail(403, "Cross-origin requests are not accepted"))
		return
	}
	if remote {
		if strings.HasPrefix(r.URL.Path, "/ui/api/auth/") || r.URL.Path == "/ui/api/secure" {
			httpx.WriteError(w, httpx.Fail(403, "Owner authorization is local-only"))
			return
		}
	}
	s.owner.Wrap(http.HandlerFunc(s.route)).ServeHTTP(w, r)
}
func (s *Server) modules() []map[string]string {
	return []map[string]string{{"name": "sessions", "status": "ready"}, {"name": "providers", "status": "ready"}, {"name": "pulls", "status": "ready"}, {"name": "agents", "status": "ready"}}
}

// Direct local UI access does not require an owner-link capsule. Control APIs
// retain webui.Authenticated; remote proxies must never inherit loopback authority.
func uiEditable(r *http.Request) bool {
	if !localPeer(r) {
		return false
	}
	if webui.Authenticated(r) {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	editable := uiEditable(r)
	if path == "/health" && r.Method == "GET" {
		httpx.JSON(w, 200, map[string]any{"ok": true, "service": "nootify", "backend": "go", "ui_transport": 1, "modules": s.modules()})
		return
	}
	if strings.HasPrefix(path, "/ui/api/") {
		if r.Method == "POST" {
			lanChoice := !localPeer(r) && (path == "/ui/api/repos" || path == "/ui/api/pulls/refresh")
			if (!editable && !lanChoice) || r.Header.Get("x-nootify-ui") != "1" {
				httpx.WriteError(w, httpx.Fail(403, "Service owner authorization is required for local settings"))
				return
			}
		}
		if path == "/ui/api/providers/registration" || path == "/ui/api/providers/setup" {
			if r.Method != http.MethodPost {
				httpx.WriteError(w, httpx.Fail(405, "Provider authorization requires a local POST"))
				return
			}
			body, err := httpx.ReadObject(r, 4096)
			var result any
			if err == nil {
				if path == "/ui/api/providers/registration" {
					result, err = s.providers.Registration(r.Context(), body)
				} else {
					result, err = s.providers.Setup(r.Context(), stringValue(body["id"]))
				}
			}
			w.Header().Set("Cache-Control", "no-store")
			if err != nil {
				providers.WriteError(w, err)
			} else {
				httpx.JSON(w, 200, result)
			}
			return
		}
		if path == "/ui/api/providers" {
			var page map[string]any
			var err error
			if r.Method == "GET" {
				page, err = s.providers.Page(r.Context())
			} else if r.Method == "POST" {
				var body map[string]any
				body, err = httpx.ReadObject(r, 65536)
				if err == nil {
					page, err = s.providers.Action(r.Context(), body)
				}
			} else {
				err = httpx.Fail(405, "Method not allowed")
			}
			if err != nil {
				providers.WriteError(w, err)
				return
			}
			page["editable"] = editable
			httpx.JSON(w, 200, page)
			return
		}
		if path == "/ui/api/settings/remote" || path == "/ui/api/settings/remote/secret" {
			s.remote(w, r, editable)
			return
		}
		if path == "/ui/api/settings" || strings.HasPrefix(path, "/ui/api/settings/") {
			s.settings.Handler().ServeHTTP(w, r)
			return
		}
		if path == "/ui/api/pulls" || path == "/ui/api/pulls/refresh" || path == "/ui/api/repos" {
			s.pulls.UIHandler().ServeHTTP(w, r)
			return
		}
		if path == "/ui/api/agents" {
			var result any
			var err error
			if r.Method == "POST" {
				var body map[string]any
				body, err = httpx.ReadObject(r, 4096)
				if err == nil {
					enabled, ok := body["enabled"].(bool)
					if !ok {
						err = httpx.Fail(400, "Expected a boolean enabled setting")
					} else {
						result, err = s.bridge.SetAgent(stringValue(body["agent"]), enabled)
					}
				}
			} else if r.Method == "GET" {
				var agents []bridge.AgentPrompt
				agents, err = s.bridge.Agents()
				result = map[string]any{"agents": agents, "editable": editable, "channel": s.providers.Channel(r.Context())}
			} else {
				err = httpx.Fail(405, "Method not allowed")
			}
			if err != nil {
				providers.WriteError(w, err)
			} else {
				httpx.JSON(w, 200, result)
			}
			return
		}
		if path == "/ui/api/snapshot" && r.Method == "GET" {
			snapshot := s.pulls.Snapshot()
			followed := 0
			for _, repository := range snapshot.Repositories {
				if repository.Followed {
					followed++
				}
			}
			access := map[string]any{"owner_authenticated": webui.Authenticated(r) && localPeer(r)}
			if address := s.lanURL(); address != "" {
				access["lan_url"] = address
			}
			if localPeer(r) {
				access["owner_ui_command"] = quote(s.options.Executable) + " ui-url --state-dir " + quote(s.store.Directory) + " --port " + strconv.Itoa(s.options.Port)
			}
			httpx.JSON(w, 200, map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "modules": s.modules(), "sessions": s.bridge.List(), "logs": s.logs.Recent(), "pulls": map[string]any{"internal": len(snapshot.Internal), "upstream": len(snapshot.Upstream), "running": snapshot.Refresh.Running, "followed": followed, "lastSuccessAt": snapshot.Refresh.LastSuccessAt, "error": snapshot.Refresh.Error, "signedOut": snapshot.Refresh.SignedOut}, "access": access})
			return
		}
		httpx.WriteError(w, httpx.Fail(404, "No such UI endpoint"))
		return
	}
	if path == "/" || strings.HasPrefix(path, "/ui/") {
		webui.Assets(s.options.Assets).ServeHTTP(w, r)
		return
	}
	if r.Header.Get("origin") != "" {
		httpx.WriteError(w, httpx.Fail(403, "Browser-origin requests are not accepted for control APIs"))
		return
	}
	if !webui.Authenticated(r) {
		httpx.WriteError(w, httpx.Fail(401, "Unauthorized"))
		return
	}
	if !localPeer(r) && strings.HasPrefix(path, "/v1/remote/") {
		httpx.WriteError(w, httpx.Fail(403, "Peer identity management is local-only"))
		return
	}
	if path == "/v1/services" && r.Method == "GET" {
		httpx.JSON(w, 200, s.modules())
		return
	}
	if path == "/v1/pulls" || path == "/v1/pulls/refresh" || path == "/v1/repos" || strings.HasPrefix(path, "/v1/repos/") {
		s.pulls.UIHandler().ServeHTTP(w, r)
		return
	}
	if strings.HasPrefix(path, "/v1/sessions") || strings.HasPrefix(path, "/v1/backends/") || strings.HasPrefix(path, "/v1/agents") {
		s.bridge.Handler().ServeHTTP(w, r)
		return
	}
	s.providers.Handler().ServeHTTP(w, r)
}
func (s *Server) remote(w http.ResponseWriter, r *http.Request, editable bool) {
	var page any
	var err error
	if strings.HasSuffix(r.URL.Path, "/secret") {
		if r.Method != "POST" {
			httpx.WriteError(w, httpx.Fail(405, "Secret reveal requires a local POST"))
			return
		}
		page, err = s.providers.Call(r.Context(), "remote.secret", nil)
	} else {
		if r.Method == "POST" {
			var body map[string]any
			body, err = httpx.ReadObject(r, 65536)
			if err == nil {
				_, err = s.providers.Call(r.Context(), "remote.configure", body)
			}
		} else if r.Method != "GET" {
			err = httpx.Fail(405, "Method not allowed")
		}
		if err == nil {
			var remote map[string]any
			remote, err = s.providers.Remote(r.Context())
			if err == nil {
				remote["editable"] = editable
				page = remote
			}
		}
	}
	if err != nil {
		providers.WriteError(w, err)
	} else {
		httpx.JSON(w, 200, page)
	}
}
func stringValue(v any) string { s, _ := v.(string); return s }
func quote(v string) string    { return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'" }
func (s *Server) enrollment() {
	defer s.wg.Done()
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		if err := s.enroll(); err != nil && s.ctx.Err() == nil {
			s.logs.Report(map[string]any{"source": "providers", "status": "session_discovery_failed", "error": err.Error()})
		}
		select {
		case <-s.ctx.Done():
			return
		case <-timer.C:
		}
	}
}
func (s *Server) enroll() error {
	agents, err := s.bridge.Agents()
	if err != nil {
		return err
	}
	enabled := map[string]bool{}
	for _, agent := range agents {
		if agent.Injected && agent.Status != "error" && agent.Status != "conflict" {
			enabled[agent.Agent] = true
		}
	}
	if len(enabled) == 0 {
		return nil
	}
	page, err := s.providers.Page(s.ctx)
	if err != nil {
		return err
	}
	encoded, _ := json.Marshal(page["providers"])
	var ps []map[string]any
	_ = json.Unmarshal(encoded, &ps)
	var selected map[string]any
	for _, p := range ps {
		if p["id"] == page["default_provider_id"] && p["enabled"] == true {
			selected = p
		}
	}
	if selected == nil || selected["type"] == "feishu" && stringValue(selected["recipient_open_id"]) == "" {
		return nil
	}
	bindings, err := s.providers.Call(s.ctx, "session.list", nil)
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(bindings)
	var existingBindings []map[string]any
	_ = json.Unmarshal(raw, &existingBindings)
	existing := map[string]bool{}
	for _, binding := range existingBindings {
		session, _ := binding["session"].(map[string]any)
		if session["node_id"] == page["node_id"] {
			existing[stringValue(session["adapter"])+":"+stringValue(session["session_id"])] = true
		}
	}
	sources := pulls.DefaultSources(s.options.Home)
	if !enabled["claude"] {
		sources.ClaudeDir = ""
		sources.DesktopRoots = nil
	}
	if !enabled["codex"] {
		sources.CodexHome = ""
	}
	if !enabled["opencode"] {
		sources.OpenCodeData = ""
	}
	include := false
	discovery, err := pulls.DiscoverSources(s.ctx, pulls.DiscoveryOptions{Home: s.options.Home, Sources: &sources, IncludeTranscripts: &include})
	if err != nil {
		return err
	}
	candidates := pulls.EligibleThreadSessions(discovery.Sessions)
	for _, candidate := range candidates {
		if s.ctx.Err() != nil {
			return s.ctx.Err()
		}
		if !enabled[candidate.Agent] || existing[candidate.Adapter+":"+candidate.ID] {
			continue
		}
		if _, err = s.providers.Call(s.ctx, "session.ensure", map[string]any{"automatic": true, "session": map[string]any{"node_id": page["node_id"], "adapter": candidate.Adapter, "session_id": candidate.ID, "name": candidate.Title}}); err != nil {
			s.logs.Report(map[string]any{"source": "providers", "status": "session_enrollment_failed", "session_id": candidate.ID, "error": err.Error()})
		}
	}
	rows, err := s.store.Rows("sessions")
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	for _, row := range rows {
		var session map[string]any
		_ = json.Unmarshal(row.Value, &session)
		adapter, id := stringValue(session["adapter"]), stringValue(session["session_id"])
		if (adapter != "trae" && adapter != "workbuddy") || !enabled[adapter] || session["host_id"] != host || existing[adapter+":"+id] {
			continue
		}
		if _, err = s.providers.Call(s.ctx, "session.ensure", map[string]any{"automatic": true, "session": map[string]any{"node_id": page["node_id"], "adapter": adapter, "session_id": id, "name": session["session_name"]}}); err != nil {
			return fmt.Errorf("enroll cooperative session: %w", err)
		}
	}
	return nil
}
