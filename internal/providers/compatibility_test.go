package providers

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/idy/nootify/internal/settings"
	"github.com/idy/nootify/internal/storage"
	core "github.com/idy/nootify/native/core"
)

const appA = "cli_0123456789abcdef"
const appB = "cli_fedcba9876543210"
const appC = "cli_0123456789abcdee"

func compatibilityHarness(t *testing.T) *Service {
	t.Helper()
	sql, e := storage.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	native, e := core.OpenStore(filepath.Join(sql.Directory, "provider-core"))
	if e != nil {
		t.Fatal(e)
	}
	// A cancelled subscription context lets real core configuration and persistence
	// run normally while guaranteeing synthetic providers never contact Feishu.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c, e := core.NewCore(ctx, native, func(string, any) error { return nil })
	if e != nil {
		t.Fatal(e)
	}
	s := &Service{options: Options{Store: sql}, core: c, store: native, ctx: ctx, cancel: cancel, compatID: "legacy-feishu", active: map[string]bool{}}
	t.Cleanup(func() { c.Close(); _ = native.Close(); _ = s.options.Store.Close() })
	return s
}
func seedProvider(t *testing.T, s *Service, id, app, secret string, enabled bool) {
	t.Helper()
	if e := s.store.Update(func(d *core.State) error {
		d.Providers[id] = core.ProviderConfig{ID: id, Name: "Synthetic " + id, Type: "feishu", Enabled: enabled, AppID: app, AppSecret: secret, Recipient: "ou_" + id}
		if d.DefaultProvider == "" {
			d.DefaultProvider = id
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}
func getCompatibility(t *testing.T, s *Service) map[string]any {
	t.Helper()
	v, e := s.Call(context.Background(), "compatibility.get", nil)
	if e != nil {
		t.Fatal(e)
	}
	return asMap(v)
}
func TestStartupCoreCredentialsBeatStaleSettingsAndMCP(t *testing.T) {
	for _, source := range []string{"settings", "mcp-config", ""} {
		t.Run(source, func(t *testing.T) {
			s := compatibilityHarness(t)
			seedProvider(t, s, "legacy-feishu", appA, "core-secret", false)
			if e := s.options.Store.SetSettings(map[string]any{"lark_app_id": appA, "lark_app_secret": "stale-secret", "lark_connection_type": "personal-app"}); e != nil {
				t.Fatal(e)
			}
			if e := s.reconcileCredentials(context.Background(), Credentials{AppID: appA, AppSecret: "stale-secret", Source: source}); e != nil {
				t.Fatal(e)
			}
			if s.store.Snapshot().Providers["legacy-feishu"].AppSecret != "core-secret" {
				t.Fatal("startup overwrote core credential authority")
			}
			v := getCompatibility(t, s)
			if asMap(v["credentials"])["appSecret"] != "core-secret" || v["source"] != "settings" || v["connection_type"] != "personal-app" {
				t.Fatalf("wrong active source: %+v", v)
			}
			if s.options.Store.Setting("lark_app_secret") != "core-secret" {
				t.Fatal("core mirror not repaired")
			}
		})
	}
}
func TestCompatibilityAppSwitchPreservesOldProviderAndScopesBindings(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "old-secret", false)
	if e := s.options.Store.SetSettings(map[string]any{"lark_app_id": appA, "lark_app_secret": "old-secret", "lark_recipient_open_id": "ou_old"}); e != nil {
		t.Fatal(e)
	}
	if e := s.options.Store.Put("lark_bindings", "legacy-chat", map[string]any{"session_id": "session-a", "chat_id": "oc_old", "sender_open_id": "ou_old"}); e != nil {
		t.Fatal(e)
	}
	v, e := s.Call(context.Background(), "compatibility.configure", map[string]any{"app_id": appB, "app_secret": "new-secret", "connection_type": "personal-app"})
	if e != nil {
		t.Fatal(e)
	}
	active := asMap(v)
	id := str(active["provider_id"])
	if id == "legacy-feishu" || id == "" {
		t.Fatal("immutable provider identity reused")
	}
	snap := s.store.Snapshot()
	if snap.Providers["legacy-feishu"].AppID != appA || snap.Providers[id].AppID != appB || snap.DefaultProvider != id {
		t.Fatal("app switch lost old provider or default")
	}
	if str(active["recipient"]) != "" {
		t.Fatal("old app recipient carried across apps")
	}
	if active["connection_type"] != "personal-app" {
		t.Fatal("personal app connection lost")
	}
	var binding map[string]any
	_, _ = s.options.Store.Get("lark_bindings", "legacy-chat", &binding)
	if binding["app_id"] != appA {
		t.Fatalf("old binding ownership lost: %+v", binding)
	}
}
func TestRecipientEditPreservesDisabledProviderAndCoreSecret(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "core-secret", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{}); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Call(context.Background(), "compatibility.configure", map[string]any{"recipient_open_id": "ou_new"}); e != nil {
		t.Fatal(e)
	}
	p := s.store.Snapshot().Providers["legacy-feishu"]
	if p.Enabled || p.AppSecret != "core-secret" || p.Recipient != "ou_new" {
		t.Fatalf("recipient edit modified provider config: %+v", p)
	}
}
func TestCompatibilityCountsOnlyLiveResources(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "core-secret", false)
	if e := s.store.Update(func(d *core.State) error {
		d.Bindings["live"] = core.Binding{ProviderID: "legacy-feishu", ChatID: "oc_a", Session: core.Session{NodeID: d.NodeID, Adapter: "codex", SessionID: "s"}, Aliases: []core.Binding{{ProviderID: "legacy-feishu", ChatID: "oc_b"}, {ProviderID: "legacy-feishu", ChatID: "oc_deleted_alias", Deleted: true}}}
		d.Bindings["deleted"] = core.Binding{ProviderID: "legacy-feishu", ChatID: "oc_deleted", Deleted: true}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	v := getCompatibility(t, s)
	if v["groups"] != 2 {
		t.Fatalf("groups: %v", v["groups"])
	}
}
func TestEnvironmentStartupDoesNotRelabelLegacyProvider(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "old-secret", false)
	if e := s.options.Store.SetSettings(map[string]any{"lark_app_id": appA, "lark_app_secret": "old-secret"}); e != nil {
		t.Fatal(e)
	}
	if e := s.reconcileCredentials(context.Background(), Credentials{AppID: appB, AppSecret: "env-secret", Recipient: "ou_env", Source: "environment"}); e != nil {
		t.Fatal(e)
	}
	snap := s.store.Snapshot()
	p := snap.Providers[environmentProviderID(appB)]
	if p.AppID != appB || p.AppSecret != "env-secret" || snap.Providers["legacy-feishu"].AppID != appA || snap.DefaultProvider != p.ID {
		t.Fatal("environment startup corrupted legacy ownership")
	}
	v := getCompatibility(t, s)
	if v["source"] != "environment" || v["recipient"] != "ou_env" {
		t.Fatal(v)
	}
	if _, e := s.Call(context.Background(), "provider.delete", map[string]any{"id": p.ID}); errorCode(e) != "conflict" {
		t.Fatalf("environment provider deleted: %v", e)
	}
	if _, e := s.Call(context.Background(), "provider.save", map[string]any{"id": p.ID, "type": "feishu", "name": "Changed", "app_id": appB, "app_secret": "other-secret", "enabled": true}); errorCode(e) != "conflict" {
		t.Fatalf("environment secret replaced: %v", e)
	}
}
func TestEnvironmentLegacyImportStoresDormantChoiceWithoutChangingActiveCore(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "env-secret", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{AppID: appA, AppSecret: "env-secret", Recipient: "ou_env", Source: "environment"}); e != nil {
		t.Fatal(e)
	}
	before := s.store.Snapshot()
	v, e := s.Call(context.Background(), "compatibility.configure", map[string]any{"import": true, "app_id": appB, "app_secret": "dormant-secret", "connection_type": "personal-app", "recipient_open_id": "ou_dormant"})
	if e != nil {
		t.Fatal(e)
	}
	active := asMap(v)
	if asMap(active["credentials"])["appId"] != appA || asMap(active["credentials"])["appSecret"] != "env-secret" || active["recipient"] != "ou_env" || active["source"] != "environment" || active["connection_type"] != "bot" {
		t.Fatalf("environment authority lost: %+v", active)
	}
	after := s.store.Snapshot()
	if len(before.Providers) != len(after.Providers) || after.Providers[s.compatID].AppSecret != "env-secret" {
		t.Fatal("dormant import mutated provider core")
	}
	if s.options.Store.Setting("lark_app_id") != appB || s.options.Store.Setting("lark_app_secret") != "dormant-secret" {
		t.Fatal("dormant saved choice not imported")
	}
}
func importedBackup(id, app, secret string) map[string]any {
	return map[string]any{"version": 1, "providers": []any{map[string]any{"id": id, "name": "Imported", "type": "feishu", "enabled": false, "app_id": app, "app_secret": secret}}, "default_provider_id": id, "remote": map[string]any{"enabled": false, "listen": "127.0.0.1:9418", "token": "listener-secret"}}
}
func TestProviderImportRetainsPersonalAppMetadataWithoutEnablingProvider(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "old-secret", false)
	_, e := s.Call(context.Background(), "config.import", map[string]any{"config": importedBackup("personal-app", appB, "imported-secret"), "lark": map[string]any{"app_id": appB, "connection_type": "personal-app"}})
	if e != nil {
		t.Fatal(e)
	}
	v := getCompatibility(t, s)
	if v["provider_id"] != "personal-app" || v["connection_type"] != "personal-app" || asMap(v["credentials"])["appSecret"] != "imported-secret" || s.store.Snapshot().Providers["personal-app"].Enabled {
		t.Fatalf("import metadata or provider identity changed: %+v", v)
	}
	if s.options.Store.Setting("lark_connection_type") != "personal-app" {
		t.Fatal("import metadata not persisted")
	}
}
func TestProviderImportRejectsEnvironmentConflictBeforeEitherStoreChanges(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "env-secret", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{AppID: appA, AppSecret: "env-secret", Source: "environment"}); e != nil {
		t.Fatal(e)
	}
	_, e := s.Call(context.Background(), "config.import", map[string]any{"config": importedBackup("other", appB, "not-env")})
	if errorCode(e) != "conflict" {
		t.Fatalf("conflicting import accepted: %v", e)
	}
	if s.store.Snapshot().Providers["legacy-feishu"].AppSecret != "env-secret" || s.options.Store.Setting("lark_app_secret") != "env-secret" {
		t.Fatal("conflict mutated existing secret")
	}
}
func TestClearSavedUsesMCPFallbackAndDoesNotRevealItAsSaved(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "saved-secret", false)
	seedProvider(t, s, "mcp", appB, "mcp-secret", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{AppID: appA, AppSecret: "saved-secret", Source: "settings"}); e != nil {
		t.Fatal(e)
	}
	v, e := s.Call(context.Background(), "compatibility.configure", map[string]any{"app_id": appB, "app_secret": "mcp-secret", "source": "mcp-config", "clear_saved": true})
	if e != nil {
		t.Fatal(e)
	}
	active := asMap(v)
	if active["source"] != "mcp-config" || asMap(active["credentials"])["appId"] != appB || s.options.Store.Setting("lark_app_id") != "" || s.options.Store.Setting("lark_app_secret") != "" {
		t.Fatalf("clear fallback: %+v", active)
	}
	if _, e = s.Call(context.Background(), "compatibility.configure", map[string]any{"app_id": "", "app_secret": "", "clear_saved": true}); e != nil {
		t.Fatal(e)
	}
	active = getCompatibility(t, s)
	if active["configured"] != false || active["credentials"] != nil {
		t.Fatal("clear selected an unrelated remaining provider")
	}
}
func TestCommittedCoreWarningMirrorsWithoutRollback(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "before", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{}); e != nil {
		t.Fatal(e)
	}
	if e := s.store.Update(func(d *core.State) error {
		p := d.Providers["legacy-feishu"]
		p.AppSecret = "committed-secret"
		d.Providers[p.ID] = p
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	warning := &core.RPCError{Code: "committed_not_durable", Message: "synthetic directory sync failure after commit"}
	_, e := s.completeCompatibilityMutation(context.Background(), map[string]any{"saved": true}, warning)
	if !errors.Is(e, warning) || s.options.Store.Setting("lark_app_secret") != "committed-secret" || s.store.Snapshot().Providers["legacy-feishu"].AppSecret != "committed-secret" {
		t.Fatal("committed warning rolled back or concealed")
	}
}
func TestMirrorFailureReportsPendingAndRepairsFromCore(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "before", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{}); e != nil {
		t.Fatal(e)
	}
	dir := s.options.Store.Directory
	if e := s.options.Store.Close(); e != nil {
		t.Fatal(e)
	}
	if e := s.store.Update(func(d *core.State) error {
		p := d.Providers["legacy-feishu"]
		p.AppSecret = "committed-secret"
		d.Providers[p.ID] = p
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	_, e := s.completeCompatibilityMutation(context.Background(), nil, nil)
	if errorCode(e) != "committed_not_mirrored" {
		t.Fatalf("missing mirror warning: %v", e)
	}
	v := getCompatibility(t, s)
	if v["mirror_status"] != "pending" || asMap(v["credentials"])["appSecret"] != "committed-secret" {
		t.Fatal("pending mirror hid committed core")
	}
	reopened, e := storage.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	s.options.Store = reopened
	v = getCompatibility(t, s)
	if v["mirror_status"] != nil || reopened.Setting("lark_app_secret") != "committed-secret" {
		t.Fatal("pending mirror not repaired")
	}
}
func TestSettingsImportWorksThroughNativeCoordinator(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "core-secret", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{}); e != nil {
		t.Fatal(e)
	}
	service, e := settings.New(settings.Options{Store: s.options.Store, Env: map[string]string{}, Core: s.Call, Verify: func(context.Context, settings.Credentials) error { return nil }})
	if e != nil {
		t.Fatal(e)
	}
	defer service.Close()
	_, e = service.ImportConfig(context.Background(), map[string]any{"format": "nootify-config", "version": 1, "lark": map[string]any{"app_id": appB, "app_secret": "new-secret", "connection_type": "personal-app"}, "providers": importedBackup("new-personal", appB, "new-secret")})
	if e != nil {
		t.Fatal(e)
	}
	page, e := service.Page(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	lark := asMap(page["lark"])
	if lark["app_id"] != appB || lark["connection_type"] != "personal-app" || lark["saved"] != true {
		t.Fatalf("settings/core shapes diverged: %+v", lark)
	}
}
func TestConcurrentCompatibilityReadsAndRecipientWrites(t *testing.T) {
	s := compatibilityHarness(t)
	seedProvider(t, s, "legacy-feishu", appA, "core-secret", false)
	if e := s.reconcileCredentials(context.Background(), Credentials{}); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 4; j++ {
				if _, e := s.Call(context.Background(), "compatibility.get", nil); e != nil {
					t.Error(e)
				}
				if _, e := s.Call(context.Background(), "compatibility.configure", map[string]any{"recipient_open_id": "ou_new"}); e != nil {
					t.Error(e)
				}
			}
		}()
	}
	wg.Wait()
}

func TestLegacyMigrationPreservesSavedAppAdaptersAndWholeChatCursor(t *testing.T) {
	s := compatibilityHarness(t)
	if e := s.options.Store.SetSettings(map[string]any{"lark_app_id": appA, "lark_app_secret": "saved-secret"}); e != nil {
		t.Fatal(e)
	}
	for id, binding := range map[string]map[string]any{
		"registered": {"session_id": "registered", "chat_id": "oc_main", "sender_open_id": "ou_owner"},
		"observed":   {"session_id": "observed", "chat_id": "oc_observed", "sender_open_id": "ou_owner"},
		"ambiguous":  {"session_id": "ambiguous", "chat_id": "oc_ambiguous", "sender_open_id": "ou_owner"},
		"other":      {"session_id": "other", "chat_id": "oc_other", "sender_open_id": "ou_other", "app_id": appB},
	} {
		if e := s.options.Store.Put("lark_bindings", id, binding); e != nil {
			t.Fatal(e)
		}
	}
	if e := s.options.Store.Put("sessions", "registered", map[string]any{"session_id": "registered", "adapter": "codex", "session_name": "Registered title"}); e != nil {
		t.Fatal(e)
	}
	for id, observation := range map[string]map[string]any{
		"observed-1": {"session_id": "observed", "adapter": "opencode"}, "observed-2": {"session_id": "observed", "adapter": "opencode"},
		"ambiguous-1": {"session_id": "ambiguous", "adapter": "codex"}, "ambiguous-2": {"session_id": "ambiguous", "adapter": "opencode"},
	} {
		if e := s.options.Store.Put("session_observations", id, observation); e != nil {
			t.Fatal(e)
		}
	}
	for id, cursor := range map[string]map[string]any{
		"whole":           {"app_id": appA, "chat_id": "oc_main", "container_type": "chat", "container_id": "oc_main", "through": 100},
		"wrong-app":       {"app_id": appB, "chat_id": "oc_main", "container_type": "chat", "container_id": "oc_main", "through": 900},
		"thread":          {"app_id": appA, "chat_id": "oc_main", "container_type": "thread", "container_id": "thread-1", "through": 800},
		"wrong-container": {"app_id": appA, "chat_id": "oc_main", "container_type": "chat", "container_id": "oc_other", "through": 700},
	} {
		if e := s.options.Store.Put("lark_poll_cursors", id, cursor); e != nil {
			t.Fatal(e)
		}
	}
	doc, e := s.legacyMigration(Credentials{AppID: appB, AppSecret: "environment-secret", Recipient: "ou_environment", Source: "environment"})
	if e != nil {
		t.Fatal(e)
	}
	if doc["app_id"] != appA || doc["app_secret"] != "saved-secret" || doc["recipient_open_id"] != "ou_owner" {
		t.Fatalf("migration credentials/inferred owner: %+v", doc)
	}
	bindings := map[string]map[string]any{}
	for _, b := range listMaps(doc["bindings"]) {
		bindings[str(b["session_id"])] = b
	}
	if bindings["registered"]["adapter"] != "codex" || bindings["registered"]["session_name"] != "Registered title" || bindings["observed"]["adapter"] != "opencode" || bindings["ambiguous"]["adapter"] != nil {
		t.Fatalf("adapter provenance lost: %+v", bindings)
	}
	if bindings["registered"]["history_cursor"] != float64(100) {
		t.Fatal("imported thread, foreign app, or foreign container cursor")
	}
	if _, e = s.raw(context.Background(), "migration.import", doc); e != nil {
		t.Fatal(e)
	}
	snap := s.store.Snapshot()
	if snap.Providers["legacy-feishu"].AppID != appA || len(snap.Bindings) != 3 {
		t.Fatal("native migration changed app scope")
	}
}
func TestStartupWarningsStayVisibleWithoutAborting(t *testing.T) {
	s := compatibilityHarness(t)
	reported := []string{}
	s.options.Report = func(v map[string]any) { reported = append(reported, str(v["status"])) }
	for _, code := range []string{"committed_not_durable", "committed_not_mirrored"} {
		if !s.startupCompatibilityWarning(&core.RPCError{Code: code, Message: "synthetic"}) {
			t.Fatal("post-commit warning aborted startup")
		}
	}
	if s.startupCompatibilityWarning(&core.RPCError{Code: "conflict", Message: "synthetic"}) || len(reported) != 2 {
		t.Fatal("rejected startup conflict was hidden")
	}
}
