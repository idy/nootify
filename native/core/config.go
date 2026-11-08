package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"strconv"
	"strings"
)

func validateProviderSet(providers map[string]ProviderConfig) error {
	enabledApps := map[string]string{}
	for id, p := range providers {
		if p.Type == "feishu" && p.Enabled {
			if previous, ok := enabledApps[p.AppID]; ok && previous != id {
				return fault("conflict", "only one enabled Feishu instance may receive events for an app_id")
			}
			enabledApps[p.AppID] = id
		}
	}
	return nil
}

func validAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" || strings.ContainsAny(host, "/\\@?# \t\r\n") {
		return fault("invalid_argument", "address must be host:port")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return fault("invalid_argument", "invalid TCP port")
	}
	return nil
}
func validateProvider(p ProviderConfig) error {
	if p.ID == "" || len(p.ID) > 128 || strings.TrimSpace(p.Name) == "" || len(p.Name) > 256 {
		return fault("invalid_argument", "provider ID and name are required")
	}
	switch p.Type {
	case "feishu":
		if p.AppID == "" || p.AppSecret == "" {
			return fault("invalid_argument", "Feishu application credentials are required")
		}
	case "remote":
		if err := validAddress(p.Address); err != nil {
			return err
		}
		if strings.TrimSpace(p.Token) == "" || strings.ContainsAny(p.Token, "\r\n") {
			return fault("invalid_argument", "a valid remote token is required")
		}
	default:
		return fault("invalid_argument", "unsupported provider type")
	}
	return nil
}
func validateRemote(r RemoteConfig) error {
	host, port, err := net.SplitHostPort(r.Listen)
	if err != nil {
		return fault("invalid_argument", "listen must be host:port")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 0 || p > 65535 {
		return fault("invalid_argument", "invalid listen port")
	}
	if (r.CertFile == "") != (r.KeyFile == "") {
		return fault("invalid_argument", "both TLS certificate and key paths are required")
	}
	if r.Enabled {
		ip := net.ParseIP(host)
		if (ip == nil || !ip.IsLoopback()) && r.CertFile == "" {
			return fault("invalid_argument", "public listeners require TLS; plaintext must use a numeric loopback address")
		}
		if strings.TrimSpace(r.Token) == "" || strings.ContainsAny(r.Token, "\r\n") {
			return fault("invalid_argument", "a valid remote token is required")
		}
	}
	if r.CertFile != "" {
		if _, err = tls.LoadX509KeyPair(r.CertFile, r.KeyFile); err != nil {
			return fault("invalid_argument", "TLS certificate or key cannot be loaded")
		}
	}
	return nil
}
func (c *Core) startProvider(p ProviderConfig) {
	c.mu.Lock()
	old := c.providers[p.ID]
	delete(c.providers, p.ID)
	c.statuses[p.ID] = "disabled"
	c.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	if !p.Enabled {
		return
	}
	var provider Provider
	switch p.Type {
	case "feishu":
		provider = newFeishu(c, p)
	case "remote":
		provider = newRemoteProvider(c, p)
	}
	c.mu.Lock()
	c.providers[p.ID] = provider
	c.statuses[p.ID] = "connecting"
	c.mu.Unlock()
	go func() {
		err := provider.Subscribe(c.ctx, func(ctx context.Context, event Event) error { return c.Ingest(ctx, event, p.ID) })
		if err != nil && c.ctx.Err() == nil {
			c.log("provider_subscription_stopped", p.ID, "")
		}
	}()
}
func (c *Core) SaveProvider(raw json.RawMessage) (ProviderSummary, error) {
	c.ops.Lock()
	defer c.ops.Unlock()
	var p ProviderConfig
	if err := json.Unmarshal(raw, &p); err != nil {
		return ProviderSummary{}, fault("invalid_argument", "invalid provider config")
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	d := c.store.Snapshot()
	if p.ID == "" {
		p.ID = uid()
	}
	old, exists := d.Providers[p.ID]
	if exists && old.Type != p.Type {
		return ProviderSummary{}, fault("conflict", "provider type cannot be changed")
	}
	if _, ok := fields["enabled"]; !ok {
		p.Enabled = true
	}
	if exists && p.Type == "feishu" && p.AppID != old.AppID && strings.TrimSpace(p.AppSecret) == "" {
		return ProviderSummary{}, fault("invalid_argument", "a new application secret is required when app_id changes")
	}
	if strings.TrimSpace(p.AppSecret) == "" {
		p.AppSecret = old.AppSecret
	}
	if p.Token == "" {
		p.Token = old.Token
	}
	if err := validateProvider(p); err != nil {
		return ProviderSummary{}, err
	}
	next := d.Providers
	next[p.ID] = p
	if err := validateProviderSet(next); err != nil {
		return ProviderSummary{}, err
	}
	if err := c.store.Update(func(d *State) error {
		d.Providers[p.ID] = p
		delete(d.ProviderTombstones, p.ID)
		if d.DefaultProvider == "" {
			d.DefaultProvider = p.ID
		}
		return nil
	}); err != nil {
		return ProviderSummary{}, err
	}
	c.startProvider(p)
	status := "disabled"
	if p.Enabled {
		status = "connecting"
	}
	return summary(p, status), nil
}
func (c *Core) DeleteProvider(id string) error {
	if id == "" {
		return fault("invalid_argument", "provider ID is required")
	}
	c.ops.Lock()
	defer c.ops.Unlock()
	if err := c.store.Update(func(d *State) error {
		// Retire notification resources before losing their provider configuration.
		// Agent conversations stay untouched; automatic discovery cannot move them.
		for _, binding := range d.Bindings {
			if binding.ProviderID == id {
				setResourceOrigin(*d, &binding, d.NodeID)
				binding.Deleted = true
				binding.DeletePending = binding.ChatID != ""
				recordTombstone(d, binding)
			}
		}
		delete(d.Providers, id)
		d.ProviderTombstones[id] = true
		if d.DefaultProvider == id {
			d.DefaultProvider = ""
		}
		return nil
	}); err != nil {
		return err
	}
	c.mu.Lock()
	p := c.providers[id]
	delete(c.providers, id)
	delete(c.statuses, id)
	c.mu.Unlock()
	c.wakePeers()
	if p != nil {
		return p.Close()
	}
	return nil
}
func (c *Core) ConfigureRemote(raw json.RawMessage) (RemoteSummary, error) {
	c.ops.Lock()
	defer c.ops.Unlock()
	d := c.store.Snapshot()
	r := d.Remote
	if err := json.Unmarshal(raw, &r); err != nil {
		return RemoteSummary{}, fault("invalid_argument", "invalid remote config")
	}
	if r.Listen == "" {
		r.Listen = "127.0.0.1:9418"
	}
	if r.Token == "" {
		r.Token = d.Remote.Token
	}
	if r.Token == "" {
		r.Token = uid() + uid()
	}
	if err := validateRemote(r); err != nil {
		return RemoteSummary{}, err
	}
	if err := c.store.Update(func(d *State) error { d.Remote = r; return nil }); err != nil {
		return RemoteSummary{}, err
	}
	c.mu.Lock()
	old := c.server
	c.server = nil
	c.mu.Unlock()
	if old != nil {
		old.stop()
	}
	if r.Enabled {
		if err := c.startServer(r); err != nil {
			return remoteSummary(c.store.Snapshot(), "failed"), fault("unavailable", "remote listener could not be started")
		}
	}
	status := "disabled"
	if r.Enabled {
		status = "listening"
	}
	return remoteSummary(c.store.Snapshot(), status), nil
}

type Backup struct {
	Version   int              `json:"version"`
	Providers []ProviderConfig `json:"providers"`
	Default   string           `json:"default_provider_id,omitempty"`
	Remote    RemoteConfig     `json:"remote"`
}

func (c *Core) ExportConfig() Backup {
	d := c.store.Snapshot()
	out := Backup{Version: 1, Default: d.DefaultProvider, Remote: d.Remote, Providers: []ProviderConfig{}}
	for _, p := range d.Providers {
		out.Providers = append(out.Providers, p)
	}
	return out
}
func (c *Core) ImportConfig(raw json.RawMessage) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return fault("invalid_argument", "invalid config backup")
	}
	if len(fields["providers"]) == 0 || string(fields["providers"]) == "null" || len(fields["remote"]) == 0 || string(fields["remote"]) == "null" {
		return fault("invalid_argument", "backup requires providers and remote configuration")
	}
	for key := range fields {
		switch key {
		case "version", "providers", "default_provider_id", "remote":
		default:
			return fault("invalid_argument", "backup contains unsupported state")
		}
	}
	var b Backup
	if err := json.Unmarshal(raw, &b); err != nil || b.Version != 1 {
		return fault("invalid_argument", "invalid config backup")
	}
	ps := map[string]ProviderConfig{}
	for _, p := range b.Providers {
		if err := validateProvider(p); err != nil {
			return err
		}
		if _, ok := ps[p.ID]; ok {
			return fault("invalid_argument", "duplicate provider ID")
		}
		ps[p.ID] = p
	}
	if err := validateProviderSet(ps); err != nil {
		return err
	}
	if b.Default != "" {
		if _, ok := ps[b.Default]; !ok {
			return fault("invalid_argument", "default provider is missing")
		}
	}
	if b.Remote.Listen == "" {
		b.Remote.Listen = "127.0.0.1:9418"
	}
	if err := validateRemote(b.Remote); err != nil {
		return err
	}
	c.ops.Lock()
	defer c.ops.Unlock()
	if err := c.store.Update(func(d *State) error {
		for id := range d.Providers {
			if _, ok := ps[id]; !ok {
				for _, binding := range d.Bindings {
					if binding.ProviderID == id {
						setResourceOrigin(*d, &binding, d.NodeID)
						binding.Deleted = true
						binding.DeletePending = binding.ChatID != ""
						recordTombstone(d, binding)
					}
				}
				d.ProviderTombstones[id] = true
			}
		}
		d.Providers = ps
		for id := range ps {
			delete(d.ProviderTombstones, id)
		}
		d.DefaultProvider = b.Default
		d.Remote = b.Remote
		return nil
	}); err != nil {
		return err
	}
	c.mu.Lock()
	old := c.providers
	c.providers = map[string]Provider{}
	sv := c.server
	c.server = nil
	c.mu.Unlock()
	for _, p := range old {
		_ = p.Close()
	}
	if sv != nil {
		sv.stop()
	}
	for _, p := range ps {
		c.startProvider(p)
	}
	if b.Remote.Enabled {
		return c.startServer(b.Remote)
	}
	return nil
}

type migration struct {
	AppID      string `json:"app_id"`
	AppSecret  string `json:"app_secret"`
	Recipient  string `json:"recipient_open_id"`
	LegacyHost string `json:"legacy_host"`
	Bindings   []struct {
		ChatID                string `json:"chat_id"`
		AppID                 string `json:"app_id"`
		SessionID             string `json:"session_id"`
		Adapter               string `json:"adapter"`
		Name                  string `json:"session_name"`
		SenderID              string `json:"sender_open_id"`
		Metadata              any    `json:"metadata"`
		RegistrationMessageID string `json:"registration_message_id"`
		ActivatedAt           int64  `json:"activated_at"`
		Pin                   bool   `json:"pin"`
	} `json:"bindings"`
}

func (c *Core) Migrate(raw json.RawMessage) (map[string]any, error) {
	var m migration
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fault("invalid_argument", "invalid migration")
	}
	if m.AppID == "" || m.AppSecret == "" {
		return map[string]any{"imported": false}, nil
	}
	c.ops.Lock()
	defer c.ops.Unlock()
	d := c.store.Snapshot()
	if d.Migrated || d.ProviderTombstones["legacy-feishu"] {
		return map[string]any{"imported": false}, nil
	}
	if _, ok := d.Providers["legacy-feishu"]; ok {
		return map[string]any{"imported": false}, nil
	}
	p := ProviderConfig{ID: "legacy-feishu", Name: "Feishu", Type: "feishu", Enabled: true, AppID: m.AppID, AppSecret: m.AppSecret, Recipient: m.Recipient}
	for _, existing := range d.Providers {
		if existing.Type == "feishu" && existing.Enabled && existing.AppID == p.AppID {
			p.Enabled = false
		}
	}
	err := c.store.Update(func(d *State) error {
		d.Migrated = true
		d.Providers[p.ID] = p
		if d.DefaultProvider == "" {
			d.DefaultProvider = p.ID
		}
		for _, v := range m.Bindings {
			if v.AppID != "" && v.AppID != m.AppID {
				continue
			}
			if v.ChatID == "" || v.SessionID == "" {
				return fault("invalid_argument", "invalid legacy binding")
			}
			adapter := v.Adapter
			if adapter == "" {
				adapter = "claude-code"
				if strings.HasPrefix(v.SessionID, "local_") {
					adapter = "claude-desktop"
				}
				if strings.HasPrefix(v.SessionID, "ses_") {
					adapter = "opencode"
				}
			}
			metadata, ok := v.Metadata.(map[string]any)
			if !ok {
				metadata = map[string]any{}
				if v.Metadata != nil {
					metadata["legacy_metadata"] = v.Metadata
				}
			}
			metadata["legacy_host"] = m.LegacyHost
			if v.RegistrationMessageID != "" {
				metadata["legacy_registration_message_id"] = v.RegistrationMessageID
			}
			if v.ActivatedAt != 0 {
				metadata["legacy_activated_at"] = v.ActivatedAt
			}
			if v.Pin {
				metadata["legacy_pin"] = true
			}
			sender := v.SenderID
			if sender == "" {
				sender = m.Recipient
			}
			s := Session{NodeID: d.NodeID, Adapter: adapter, SessionID: v.SessionID, Name: v.Name, Metadata: metadata}
			if old, exists := d.Bindings[s.key()]; exists {
				if old.ProviderID == p.ID && old.ChatID != v.ChatID {
					return fault("conflict", "legacy session has multiple groups")
				}
			} else {
				d.Bindings[s.key()] = Binding{ProviderID: p.ID, Session: s, ChatID: v.ChatID, SenderID: sender}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	c.startProvider(p)
	return map[string]any{"imported": true}, nil
}

type commandRouteKey struct{}

func commandRoute(ctx context.Context) []string {
	v, _ := ctx.Value(commandRouteKey{}).([]string)
	return v
}
