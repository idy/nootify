package providers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/idy/nootify/internal/storage"
	core "github.com/idy/nootify/native/core"
)

// All compatibility methods run under Service.ops. The native core is the live
// credential authority; SQLite is only a compatibility mirror and startup input.
func environmentProviderID(app string) string {
	sum := sha256.Sum256([]byte(app))
	return "environment-feishu-" + hex.EncodeToString(sum[:])[:16]
}
func settingsProviderID(app string) string {
	sum := sha256.Sum256([]byte(app))
	return "settings-feishu-" + hex.EncodeToString(sum[:])[:16]
}
func compatibilityFault(code, message string) error {
	return &core.RPCError{Code: code, Message: message}
}
func provenRejection(err error) bool {
	switch errorCode(err) {
	case "invalid_argument", "not_found", "permission_denied", "unauthenticated", "conflict", "already_exists", "failed_precondition", "unsupported", "method_not_found", "resource_exhausted":
		return true
	}
	return false
}
func committedMutation(err error) bool {
	return err == nil || errorCode(err) == "committed_not_durable"
}
func matchingProvider(providers []map[string]any, app, id string) map[string]any {
	var selected map[string]any
	for _, p := range providers {
		if p["type"] != "feishu" || p["app_id"] != app {
			continue
		}
		if selected == nil || p["enabled"] == true && selected["enabled"] != true || p["enabled"] == selected["enabled"] && p["id"] == id {
			selected = p
		}
	}
	return selected
}
func (s *Service) providerConfig(ctx context.Context) (map[string]any, []map[string]any, error) {
	v, e := s.raw(ctx, "config.export", nil)
	if e != nil {
		return nil, nil, e
	}
	config := asMap(v)
	providers := listMaps(config["providers"])
	sort.Slice(providers, func(i, j int) bool { return str(providers[i]["id"]) < str(providers[j]["id"]) })
	return config, providers, nil
}
func (s *Service) selectedProvider(ctx context.Context) (map[string]any, error) {
	_, ps, e := s.providerConfig(ctx)
	if e != nil {
		return nil, e
	}
	for _, p := range ps {
		if p["type"] == "feishu" && p["id"] == s.compatID {
			return p, nil
		}
	}
	return nil, nil
}
func (s *Service) selectCompatibility(config map[string]any, providers []map[string]any, preferred string) {
	selected := matchingProvider(providers, preferred, s.compatID)
	if selected == nil {
		for _, p := range providers {
			if p["type"] == "feishu" && p["id"] == s.compatID {
				selected = p
				break
			}
		}
	}
	if selected == nil {
		for _, p := range providers {
			if p["type"] == "feishu" && p["id"] == "legacy-feishu" {
				selected = p
				break
			}
		}
	}
	if selected == nil {
		for _, p := range providers {
			if p["type"] == "feishu" && p["id"] == config["default_provider_id"] {
				selected = p
				break
			}
		}
	}
	if selected == nil {
		for _, p := range providers {
			if p["type"] == "feishu" {
				selected = p
				break
			}
		}
	}
	s.compatID = ""
	if selected != nil {
		s.compatID = str(selected["id"])
	}
}
func (s *Service) compatibility(ctx context.Context) (map[string]any, error) {
	selected, e := s.selectedProvider(ctx)
	if e != nil {
		return nil, e
	}
	kind := s.compatConnectionType
	if kind == "" {
		kind = "bot"
		if selected != nil && s.options.Store.Setting("lark_app_id") == str(selected["app_id"]) {
			kind = first(s.options.Store.Setting("lark_connection_type"), "bot")
		}
	}
	source := s.source
	if selected != nil {
		if str(selected["app_id"]) == s.environment.AppID && str(selected["app_secret"]) == s.environment.AppSecret && s.environment.AppID != "" {
			source = "environment"
		} else if source != "mcp-config" {
			source = "settings"
		}
		if source == "environment" {
			kind = "bot"
		}
	} else {
		source = ""
		kind = "bot"
	}
	result := map[string]any{"configured": selected != nil, "source": source, "connection_type": kind, "status": "disabled", "groups": 0}
	if s.mirrorPending {
		result["mirror_status"] = "pending"
	}
	if selected != nil {
		result["provider_id"] = s.compatID
		result["app_id"] = selected["app_id"]
		result["credentials"] = map[string]any{"appId": selected["app_id"], "appSecret": selected["app_secret"]}
		if recipient := str(selected["recipient_open_id"]); recipient != "" {
			result["recipient"] = recipient
		}
		page, e := s.Page(ctx)
		if e != nil {
			return nil, e
		}
		for _, p := range listMaps(page["providers"]) {
			if p["id"] == s.compatID {
				result["status"] = p["status"]
			}
		}
	}
	bindings, e := s.raw(ctx, "session.list", nil)
	if e != nil {
		return nil, e
	}
	groups := 0
	for _, b := range listMaps(bindings) {
		if b["deleted"] == true {
			continue
		}
		if str(b["chat_id"]) != "" {
			groups++
		}
		for _, alias := range listMaps(b["aliases"]) {
			if alias["deleted"] != true && str(alias["chat_id"]) != "" {
				groups++
			}
		}
	}
	result["groups"] = groups
	return result, nil
}
func (s *Service) persistMirror(values map[string]any, previousApp, nextApp string) error {
	s.pendingMirror = values
	if previousApp == "" {
		previousApp = s.mirrorApp
	}
	s.mirrorApp = nextApp
	s.pendingScopesApp = ""
	if previousApp != "" && previousApp != nextApp {
		s.pendingScopesApp = previousApp
	}
	return s.repairCompatibilityMirror()
}
func (s *Service) repairCompatibilityMirror() error {
	if s.pendingMirror == nil {
		return nil
	}
	err := s.applyMirror(s.pendingMirror, s.pendingScopesApp)
	if err != nil {
		s.mirrorPending = true
		s.report(map[string]any{"status": "compatibility_mirror_pending"})
		return compatibilityFault("committed_not_mirrored", "Provider configuration committed; saving its local compatibility mirror is pending")
	}
	s.mirrorPending = false
	s.pendingMirror = nil
	s.pendingScopesApp = ""
	return nil
}
func (s *Service) applyMirror(values map[string]any, previousApp string) error {
	return s.options.Store.Update(func(tx *storage.Tx) error {
		if previousApp != "" {
			rows, e := tx.Rows("lark_bindings")
			if e != nil {
				return e
			}
			for _, row := range rows {
				b := asMap(row.Value)
				if str(b["app_id"]) == "" {
					b["app_id"] = previousApp
					if e = tx.Put("lark_bindings", row.ID, b); e != nil {
						return e
					}
				}
			}
		}
		for key, v := range values {
			if v == nil {
				if e := tx.Delete("settings", key); e != nil {
					return e
				}
			} else if e := tx.Put("settings", key, v); e != nil {
				return e
			}
		}
		return nil
	})
}
func (s *Service) mirrorCompatibility(ctx context.Context) error {
	config, e := s.compatibility(ctx)
	if e != nil {
		return e
	}
	creds := asMap(config["credentials"])
	app := str(creds["appId"])
	old := s.options.Store.Setting("lark_app_id")
	values := map[string]any{"lark_app_id": nil, "lark_app_secret": nil, "lark_recipient_open_id": nil, "lark_connection_type": nil}
	if app != "" {
		if !s.savedCleared {
			values["lark_app_id"] = app
			values["lark_app_secret"] = creds["appSecret"]
			values["lark_connection_type"] = config["connection_type"]
		}
		if recipient := str(config["recipient"]); recipient != "" {
			values["lark_recipient_open_id"] = recipient
		}
	}
	return s.persistMirror(values, old, app)
}

// completeCompatibilityMutation mirrors confirmed commits and uncertain outcomes
// from the core snapshot without ever resubmitting or rolling back the mutation.
func (s *Service) completeCompatibilityMutation(ctx context.Context, result any, mutationErr error) (any, error) {
	if provenRejection(mutationErr) {
		return result, mutationErr
	}
	return s.completeCompatibilityCommit(ctx, result, mutationErr)
}
func (s *Service) completeCompatibilityCommit(ctx context.Context, result any, mutationErr error) (any, error) {
	mirrorErr := s.mirrorCompatibility(ctx)
	if mutationErr == nil {
		mutationErr = mirrorErr
	}
	if s.network != nil {
		if e := s.network(ctx); e != nil {
			s.report(map[string]any{"status": "network_reconciliation_failed", "error": e.Error()})
		}
	}
	return result, mutationErr
}
func (s *Service) checkEnvironmentMutation(ctx context.Context, method string, body map[string]any) error {
	if s.environment.AppID == "" {
		return nil
	}
	if method == "config.import" {
		doc := body
		if _, ok := body["config"]; ok {
			doc = asMap(body["config"])
		}
		p := matchingProvider(listMaps(doc["providers"]), s.environment.AppID, s.compatID)
		if p == nil || str(p["app_secret"]) != s.environment.AppSecret {
			return compatibilityFault("conflict", "Imported providers conflict with the active environment Feishu credentials; preserve the environment provider")
		}
		return nil
	}
	if (method == "provider.save" || method == "provider.delete") && str(body["id"]) == s.compatID {
		if method == "provider.delete" {
			return compatibilityFault("conflict", "Provider changes conflict with the active environment Feishu credentials")
		}
		secret := str(body["app_secret"])
		if strings.TrimSpace(secret) == "" {
			secret = s.environment.AppSecret
		}
		if str(body["app_id"]) != s.environment.AppID || secret != s.environment.AppSecret {
			return compatibilityFault("conflict", "Provider changes conflict with the active environment Feishu credentials")
		}
	}
	return nil
}
func (s *Service) importCompatibility(ctx context.Context, body map[string]any) (any, error) {
	if e := s.checkEnvironmentMutation(ctx, "config.import", body); e != nil {
		return nil, e
	}
	result, err := s.raw(ctx, "config.import", body)
	if committedMutation(err) {
		config, providers, e := s.providerConfig(ctx)
		if e != nil {
			if err == nil {
				err = e
			}
			return result, err
		}
		lark := asMap(body["lark"])
		preferred := str(lark["app_id"])
		if s.environment.AppID != "" {
			preferred = s.environment.AppID
		}
		s.selectCompatibility(config, providers, preferred)
		s.savedCleared = false
		s.source = "settings"
		s.compatConnectionType = "bot"
		if p, e := s.selectedProvider(ctx); e == nil && p != nil && str(p["app_id"]) == str(lark["app_id"]) && (lark["connection_type"] == "bot" || lark["connection_type"] == "personal-app") {
			s.compatConnectionType = str(lark["connection_type"])
		}
	}
	return s.completeCompatibilityMutation(ctx, result, err)
}
func (s *Service) configureCompatibility(ctx context.Context, body map[string]any) (map[string]any, error) {
	if e := s.repairCompatibilityMirror(); e != nil {
		return nil, e
	}
	current, e := s.selectedProvider(ctx)
	if e != nil {
		return nil, e
	}
	currentApp := str(current["app_id"])
	imported := body["import"] == true
	clear := body["clear_saved"] == true
	// Saved legacy imports can coexist with an environment override. They do not
	// switch, disable or reconfigure the active environment provider.
	if imported && s.environment.AppID != "" {
		values := map[string]any{}
		nextApp := s.options.Store.Setting("lark_app_id")
		if app := str(body["app_id"]); app != "" {
			nextApp = app
			values["lark_app_id"] = app
			values["lark_app_secret"] = body["app_secret"]
			kind := first(str(body["connection_type"]), "bot")
			values["lark_connection_type"] = kind
			if app != s.options.Store.Setting("lark_app_id") {
				values["lark_recipient_open_id"] = nil
			}
		}
		if recipient, ok := body["recipient_open_id"]; ok {
			values["lark_recipient_open_id"] = recipient
		}
		previousApp := s.options.Store.Setting("lark_app_id")
		if previousApp == nextApp {
			previousApp = ""
		}
		if e = s.applyMirror(values, previousApp); e != nil {
			return nil, e
		}
		return s.compatibility(ctx)
	}
	app, secret := str(body["app_id"]), str(body["app_secret"])
	if _, ok := body["app_id"]; !ok {
		app = currentApp
	}
	if _, ok := body["app_secret"]; !ok {
		if app == currentApp {
			secret = str(current["app_secret"])
		}
	}
	if s.environment.AppID != "" {
		if !clear && (app != s.environment.AppID || secret != s.environment.AppSecret) {
			return nil, compatibilityFault("conflict", "Environment credentials take precedence")
		}
		app, secret = s.environment.AppID, s.environment.AppSecret
	}
	recipient := str(body["recipient_open_id"])
	if _, ok := body["recipient_open_id"]; !ok && app == currentApp {
		recipient = str(current["recipient_open_id"])
	}
	config, providers, e := s.providerConfig(ctx)
	if e != nil {
		return nil, e
	}
	beforeID := s.compatID
	oldDefault := str(config["default_provider_id"])
	var mutationErr error
	if clear && app == "" {
		if current != nil {
			_, mutationErr = s.raw(ctx, "provider.delete", map[string]any{"id": beforeID})
		}
		if !committedMutation(mutationErr) {
			_, err := s.completeCompatibilityMutation(ctx, nil, mutationErr)
			return nil, err
		}
		s.compatID = ""
		s.compatConnectionType = "bot"
		s.source = ""
		s.savedCleared = true
	} else {
		if app == "" || secret == "" {
			return nil, compatibilityFault("invalid_argument", "Feishu app credentials are required")
		}
		selected := matchingProvider(providers, app, s.compatID)
		if selected == nil {
			id := settingsProviderID(app)
			if s.compatID == "legacy-feishu" && current == nil {
				id = "legacy-feishu"
			}
			for _, p := range providers {
				if p["id"] == id {
					return nil, compatibilityFault("conflict", "Compatibility provider ID belongs to another provider")
				}
			}
			selected = map[string]any{"id": id, "type": "feishu", "name": "Feishu", "enabled": true, "app_id": app}
		}
		copy := map[string]any{}
		for key, value := range selected {
			copy[key] = value
		}
		selected = copy
		// A recipient-only edit must preserve a disabled imported provider.
		if _, hasApp := body["app_id"]; hasApp && !clear {
			selected["enabled"] = true
		}
		selected["app_secret"] = secret
		selected["recipient_open_id"] = recipient
		changed := true
		for _, old := range providers {
			if old["id"] == selected["id"] {
				changed = old["app_secret"] != secret || old["recipient_open_id"] != selected["recipient_open_id"] || old["enabled"] != selected["enabled"]
				break
			}
		}
		if changed {
			_, mutationErr = s.raw(ctx, "provider.save", selected)
		}
		if !committedMutation(mutationErr) {
			_, err := s.completeCompatibilityMutation(ctx, nil, mutationErr)
			return nil, err
		}
		s.compatID = str(selected["id"])
		s.source = "settings"
		if s.environment.AppID != "" {
			s.source = "environment"
		}
		if clear {
			if source := str(body["source"]); source != "" {
				s.source = source
			}
		}
		s.savedCleared = clear
		kind := str(body["connection_type"])
		if kind == "bot" || kind == "personal-app" {
			s.compatConnectionType = kind
		} else if currentApp != app {
			s.compatConnectionType = "bot"
		}
		if oldDefault == "" || oldDefault == beforeID {
			if oldDefault != s.compatID {
				_, warning := s.raw(ctx, "provider.default", map[string]any{"id": s.compatID})
				if mutationErr == nil {
					mutationErr = warning
				}
			}
		}
	}
	_, err := s.completeCompatibilityCommit(ctx, nil, mutationErr)
	result, getErr := s.compatibility(ctx)
	if err != nil {
		return result, err
	}
	return result, getErr
}
func (s *Service) reconcileCredentials(ctx context.Context, credentials Credentials) error {
	if credentials.Source == "environment" {
		if credentials.AppID == "" || credentials.AppSecret == "" {
			return compatibilityFault("invalid_argument", "Set both LARK_APP_ID and LARK_APP_SECRET")
		}
		s.environment = credentials
	}
	config, providers, e := s.providerConfig(ctx)
	if e != nil {
		return e
	}
	if s.environment.AppID == "" {
		// Existing core providers win over stale SQLite or MCP credentials.
		s.selectCompatibility(config, providers, credentials.AppID)
		s.source = "settings"
		s.compatConnectionType = ""
		s.savedCleared = false
		return s.mirrorCompatibility(ctx)
	}
	env := s.environment
	selected := matchingProvider(providers, env.AppID, s.compatID)
	if selected == nil {
		id := environmentProviderID(env.AppID)
		for _, p := range providers {
			if p["id"] == id {
				return compatibilityFault("conflict", "Environment provider ID belongs to another provider")
			}
		}
		selected = map[string]any{"id": id, "type": "feishu", "name": "Feishu (environment)", "enabled": true, "app_id": env.AppID}
	}
	var warning error
	if selected["app_secret"] != env.AppSecret || env.Recipient != "" && selected["recipient_open_id"] != env.Recipient {
		selected["app_secret"] = env.AppSecret
		if env.Recipient != "" {
			selected["recipient_open_id"] = env.Recipient
		}
		_, warning = s.raw(ctx, "provider.save", selected)
		if !committedMutation(warning) {
			return warning
		}
	}
	s.compatID = str(selected["id"])
	s.source = "environment"
	s.compatConnectionType = "bot"
	s.savedCleared = false
	defaultID := str(config["default_provider_id"])
	priorApp := s.options.Store.Setting("lark_app_id")
	managed := defaultID == ""
	for _, p := range providers {
		if p["id"] == defaultID && p["type"] == "feishu" && (defaultID == "legacy-feishu" || priorApp != "" && defaultID == environmentProviderID(priorApp) && p["app_id"] == priorApp) {
			managed = true
		}
	}
	if managed && defaultID != s.compatID {
		_, e = s.raw(ctx, "provider.default", map[string]any{"id": s.compatID})
		if warning == nil {
			warning = e
		}
	}
	_, e = s.completeCompatibilityCommit(ctx, nil, warning)
	return e
}
