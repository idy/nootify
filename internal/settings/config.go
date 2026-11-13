package settings

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/idy/nootify/internal/privatepath"
	"github.com/idy/nootify/internal/storage"
)

var agentIDs = []string{"claude", "codex", "opencode", "trae", "workbuddy"}

type configFile struct {
	Format     string         `json:"format"`
	Version    int            `json:"version"`
	ExportedAt string         `json:"exported_at"`
	Lark       map[string]any `json:"lark,omitempty"`
	Backends   map[string]any `json:"backends,omitempty"`
	Agents     []string       `json:"agents,omitempty"`
	Providers  map[string]any `json:"providers,omitempty"`
}
type ImportSummary struct {
	ExportedAt    string   `json:"exported_at,omitempty"`
	AppID         string   `json:"app_id,omitempty"`
	Recipient     string   `json:"recipient,omitempty"`
	Backends      []string `json:"backends"`
	Agents        []string `json:"agents"`
	Warnings      []string `json:"warnings"`
	ProviderCount *int     `json:"provider_count,omitempty"`
}

func summarize(f configFile) ImportSummary {
	r := ImportSummary{ExportedAt: f.ExportedAt, AppID: text(f.Lark["app_id"]), Recipient: text(f.Lark["recipient_open_id"]), Backends: []string{}, Agents: append([]string{}, f.Agents...), Warnings: []string{}}
	for _, id := range []string{"codex", "opencode"} {
		if f.Backends[id] != nil {
			r.Backends = append(r.Backends, id)
		}
	}
	if f.Providers != nil {
		n := len(array(f.Providers["providers"]))
		r.ProviderCount = &n
	}
	return r
}
func parseConfig(v any) (configFile, error) {
	m, e := jsonObject(v)
	if e != nil || m == nil || m["format"] != "nootify-config" {
		return configFile{}, problem(400, "Not a Nootify configuration file")
	}
	if number(m["version"]) != 1 {
		return configFile{}, problem(400, "This configuration file comes from a newer version of Nootify")
	}
	f := configFile{Format: "nootify-config", Version: 1, ExportedAt: text(m["exported_at"])}
	if v, ok := m["lark"]; ok {
		l := object(v)
		if l == nil {
			return f, problem(400, "Invalid lark section")
		}
		_, hasID := l["app_id"]
		_, hasSecret := l["app_secret"]
		if hasID != hasSecret {
			return f, problem(400, "app_id and app_secret must appear together")
		}
		if hasID && (!appPattern.MatchString(text(l["app_id"])) || text(l["app_secret"]) == "") {
			return f, problem(400, "Invalid Feishu app credentials")
		}
		if v, ok := l["recipient_open_id"]; ok && !openPattern.MatchString(text(v)) {
			return f, problem(400, "Invalid Feishu recipient")
		}
		if v, ok := l["connection_type"]; ok && (!hasID || (v != "bot" && v != "personal-app")) {
			return f, problem(400, "Invalid Feishu connection type or missing app credentials")
		}
		f.Lark = map[string]any{}
		for _, key := range []string{"app_id", "app_secret", "recipient_open_id", "connection_type"} {
			if v, ok := l[key]; ok {
				f.Lark[key] = v
			}
		}
	}
	// Removed feature sections in older exports are ignored, like other unknown fields.
	if v, ok := m["backends"]; ok {
		b := object(v)
		if b == nil {
			return f, problem(400, "Invalid backends section")
		}
		f.Backends = map[string]any{}
		for _, id := range []string{"codex", "opencode"} {
			if v, ok := b[id]; ok {
				out, e := validateBackend(v, id)
				if e != nil {
					return f, e
				}
				f.Backends[id] = out
			}
		}
	}
	if v, ok := m["providers"]; ok {
		p := object(v)
		if e = validateProviders(p); e != nil {
			return f, e
		}
		f.Providers = p
	}
	if v, ok := m["agents"]; ok {
		list, ok := v.([]any)
		if !ok {
			return f, problem(400, "Invalid agents section")
		}
		chosen := map[string]bool{}
		for _, v := range list {
			id := text(v)
			known := false
			for _, a := range agentIDs {
				if id == a {
					known = true
				}
			}
			if !known {
				return f, problem(400, "Invalid agents section")
			}
			chosen[id] = true
		}
		f.Agents = []string{}
		for _, a := range agentIDs {
			if chosen[a] {
				f.Agents = append(f.Agents, a)
			}
		}
	}
	return f, nil
}
func validateBackend(v any, id string) (map[string]any, error) {
	m := object(v)
	if m == nil {
		return nil, problem(400, "Invalid "+id+" backend")
	}
	raw, ok := m["url"].(string)
	if !ok {
		return nil, problem(400, "Invalid "+id+" backend")
	}
	u, e := url.Parse(raw)
	validScheme := u != nil && ((id == "codex" && (u.Scheme == "ws" || u.Scheme == "wss")) || (id == "opencode" && (u.Scheme == "http" || u.Scheme == "https")))
	if e != nil || !validScheme || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") {
		return nil, problem(400, id+": Backend endpoint must be a local URL without embedded credentials")
	}
	if u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, problem(400, "Invalid "+id+" backend port")
		}
	}
	out := map[string]any{"url": raw}
	for _, key := range []string{"token", "username", "password", "directory"} {
		if v, ok := m[key]; ok {
			if _, ok := v.(string); !ok {
				return nil, problem(400, "Invalid "+id+" backend "+key)
			}
			out[key] = v
		}
	}
	return out, nil
}
func validateAddress(raw string, zero bool) bool {
	host, p, e := net.SplitHostPort(raw)
	if e != nil || host == "" || strings.ContainsAny(host, "/\\@?# \t\r\n") {
		return false
	}
	port, e := strconv.Atoi(p)
	return e == nil && port <= 65535 && (port >= 1 || zero && port == 0)
}
func stringFields(m map[string]any, keys ...string) bool {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			if _, ok := v.(string); !ok {
				return false
			}
		}
	}
	return true
}
func boolFields(m map[string]any, keys ...string) bool {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			if _, ok := v.(bool); !ok {
				return false
			}
		}
	}
	return true
}
func validateProviders(p map[string]any) error {
	bad := func() error { return problem(400, "Invalid providers configuration") }
	if p == nil || number(p["version"]) != 1 {
		return bad()
	}
	for key := range p {
		switch key {
		case "version", "providers", "default_provider_id", "remote":
		default:
			return bad()
		}
	}
	list, ok := p["providers"].([]any)
	if !ok {
		return bad()
	}
	ids, enabled := map[string]bool{}, map[string]bool{}
	for _, v := range list {
		m := object(v)
		id, name := text(m["id"]), text(m["name"])
		if m == nil || id == "" || len(id) > 128 || trim(name) == "" || len(name) > 256 || ids[id] || !stringFields(m, "id", "name", "type", "connection_type", "app_id", "app_secret", "recipient_open_id", "address", "token", "server_name") || !boolFields(m, "enabled", "tls") {
			return bad()
		}
		ids[id] = true
		if kind, exists := m["connection_type"]; exists && (m["type"] != "feishu" || (kind != "bot" && kind != "personal-app")) {
			return bad()
		}
		switch m["type"] {
		case "feishu":
			if text(m["app_id"]) == "" || text(m["app_secret"]) == "" {
				return bad()
			}
			if m["enabled"] == true {
				app := text(m["app_id"])
				if enabled[app] {
					return bad()
				}
				enabled[app] = true
			}
		case "remote":
			address, token := text(m["address"]), text(m["token"])
			if !validateAddress(address, false) || trim(token) == "" || strings.ContainsAny(token, "\r\n") {
				return bad()
			}
			host, _, _ := net.SplitHostPort(address)
			if m["tls"] != true && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
				return bad()
			}
		default:
			return bad()
		}
	}
	if v, ok := p["default_provider_id"]; ok {
		if _, ok := v.(string); !ok {
			return bad()
		}
		if text(v) != "" && !ids[text(v)] {
			return bad()
		}
	}
	// Core backups include remote. Requiring it prevents an incomplete import from resetting listener secrets.
	r := object(p["remote"])
	if r == nil || !stringFields(r, "listen", "token", "tls_cert_file", "tls_key_file") || !boolFields(r, "enabled") {
		return bad()
	}
	listen := text(r["listen"])
	if listen == "" {
		listen = "127.0.0.1:9418"
	}
	if !validateAddress(listen, true) || (text(r["tls_cert_file"]) == "") != (text(r["tls_key_file"]) == "") {
		return bad()
	}
	if r["enabled"] == true {
		host, _, _ := net.SplitHostPort(listen)
		ip := net.ParseIP(host)
		if (ip == nil || !ip.IsLoopback()) && text(r["tls_cert_file"]) == "" {
			return bad()
		}
		if trim(text(r["token"])) == "" || strings.ContainsAny(text(r["token"]), "\r\n") {
			return bad()
		}
	}
	return nil
}
func (s *Service) configFile(ctx context.Context) (configFile, error) {
	c, e := s.compatibility(ctx)
	if e != nil {
		return configFile{}, e
	}
	f := configFile{Format: "nootify-config", Version: 1, ExportedAt: s.now().UTC().Format(time.RFC3339Nano), Lark: map[string]any{}, Backends: map[string]any{}, Agents: []string{}}
	creds := c.credentials()
	if creds.AppID != "" && creds.AppSecret != "" {
		ct := c.ConnectionType
		if ct == "" {
			ct = "bot"
		}
		f.Lark = map[string]any{"app_id": creds.AppID, "app_secret": creds.AppSecret, "connection_type": ct}
	}
	if c.Recipient != "" {
		f.Lark["recipient_open_id"] = c.Recipient
	}
	for _, id := range []string{"codex", "opencode"} {
		var b map[string]any
		ok, e := s.options.Store.Get("backends", id, &b)
		if e != nil {
			return f, e
		}
		if ok {
			f.Backends[id] = b
		}
	}
	if s.options.Agents != nil {
		v, e := s.options.Agents()
		if e != nil {
			return f, e
		}
		b, e := json.Marshal(v)
		if e != nil {
			return f, e
		}
		var a []map[string]any
		if e = json.Unmarshal(b, &a); e != nil {
			return f, e
		}
		for _, v := range a {
			if v["injected"] == true {
				f.Agents = append(f.Agents, text(v["agent"]))
			}
		}
	}
	if s.options.Core != nil {
		v, e := s.core(ctx, "config.export", nil)
		if e != nil {
			return f, e
		}
		f.Providers, e = jsonObject(v)
		if e != nil {
			return f, e
		}
	}
	return f, nil
}
func (s *Service) writeExport(f configFile) (string, error) {
	dir := s.exportsDir()
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	if e := privatepath.Protect(dir, true); e != nil {
		return "", e
	}
	id := make([]byte, 4)
	if _, e := rand.Read(id); e != nil {
		return "", e
	}
	name := "nootify-config-" + strings.NewReplacer(":", "-", ".", "-").Replace(f.ExportedAt) + "-" + hex.EncodeToString(id) + ".json"
	path := filepath.Join(dir, name)
	b, e := json.MarshalIndent(f, "", "  ")
	if e != nil {
		return "", e
	}
	file, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return "", e
	}
	e = privatepath.Protect(path, false)
	if e == nil {
		_, e = file.Write(append(b, '\n'))
	}
	if e == nil {
		e = file.Sync()
	}
	ce := file.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		_ = os.Remove(path)
		return "", e
	}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return "", e
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && entry.Name() != name && strings.HasPrefix(entry.Name(), "nootify-config-") && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names[:max(0, len(names)-9)] {
		_ = os.Remove(filepath.Join(dir, name))
	}
	s.mu.Lock()
	s.lastExport = path
	s.mu.Unlock()
	return path, nil
}
func (s *Service) ExportConfig(ctx context.Context) (map[string]any, error) {
	s.writes.Lock()
	defer s.writes.Unlock()
	f, e := s.configFile(ctx)
	if e != nil {
		return nil, e
	}
	path, e := s.writeExport(f)
	if e != nil {
		return nil, e
	}
	s.report("config_exported", "host")
	return map[string]any{"path": path, "summary": summarize(f)}, nil
}
func (s *Service) PreviewImport(v any) (ImportSummary, error) {
	f, e := parseConfig(v)
	if e != nil {
		return ImportSummary{}, e
	}
	return summarize(f), nil
}
func (s *Service) ImportConfig(ctx context.Context, v any) (ImportSummary, error) {
	// Parse every section before even cancelling registration or writing a backup.
	f, e := parseConfig(v)
	if e != nil {
		return ImportSummary{}, e
	}
	summary := summarize(f)
	if _, e = s.CancelRegistration(); e != nil {
		return summary, e
	}
	s.writes.Lock()
	defer s.writes.Unlock()
	if s.options.Core == nil && (f.Providers != nil || len(f.Lark) > 0) {
		return summary, problem(400, "Provider configuration is not supported by this service")
	}
	if f.Providers != nil && s.environmentOverride() {
		env, _, e := resolveCredentials(s.env, "", "", "")
		if e != nil {
			return summary, e
		}
		match := false
		for _, p := range array(f.Providers["providers"]) {
			m := object(p)
			if m["type"] == "feishu" && text(m["app_id"]) == env.AppID && text(m["app_secret"]) == env.AppSecret {
				match = true
			}
		}
		if !match {
			return summary, problem(409, "Imported providers conflict with the active environment Feishu credentials; preserve the environment provider")
		}
	}
	// Refuse unreadable fallback configuration before applying either store.
	if f.Providers == nil && text(f.Lark["app_id"]) != "" {
		if _, _, e = resolveCredentials(s.env, text(f.Lark["app_id"]), text(f.Lark["app_secret"]), s.options.MCPConfig); e != nil {
			return summary, e
		}
	}
	backup, e := s.configFile(ctx)
	if e != nil {
		return summary, e
	}
	if _, e = s.writeExport(backup); e != nil {
		return summary, e
	}
	if f.Providers != nil {
		_, e = s.core(ctx, "config.import", map[string]any{"config": f.Providers, "lark": f.Lark})
		s.mu.Lock()
		s.refresh++
		s.mu.Unlock()
		s.cache.clear()
		if e != nil {
			return summary, e
		}
	} else if len(f.Lark) > 0 {
		p := map[string]any{"import": true}
		for k, v := range f.Lark {
			p[k] = v
		}
		if text(p["app_id"]) != "" && p["connection_type"] == nil {
			p["connection_type"] = "bot"
		}
		if e = s.configure(ctx, p); e != nil {
			return summary, e
		}
	}
	if len(f.Backends) > 0 {
		e = s.options.Store.Update(func(tx *storage.Tx) error {
			for id, v := range f.Backends {
				if e := tx.Put("backends", id, v); e != nil {
					return e
				}
			}
			return nil
		})
		if e != nil {
			return summary, e
		}
	}
	for _, agent := range f.Agents {
		if s.options.SetAgent == nil {
			summary.Warnings = append(summary.Warnings, agent+": agent prompts are not available")
			continue
		}
		if _, e = s.options.SetAgent(agent, true); e != nil {
			summary.Warnings = append(summary.Warnings, fmt.Sprintf("%s: %s", agent, e))
		}
	}
	if text(f.Lark["app_id"]) != "" && s.environmentOverride() {
		summary.Warnings = append(summary.Warnings, "LARK_APP_ID and LARK_APP_SECRET are set for this process and stay in use")
	}
	s.report("config_imported", "host")
	return summary, nil
}
