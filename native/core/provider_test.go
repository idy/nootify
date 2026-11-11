package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestConcreteProvidersImplementCommonBotSubscription(t *testing.T) {
	c := testCore(t, nil)
	bots := []Bot{newFeishu(c, ProviderConfig{ID: "f", AppID: "app", AppSecret: "secret"}), newRemoteProvider(c, ProviderConfig{ID: "r", Address: "127.0.0.1:1", Token: "fixture"})}
	for _, bot := range bots {
		if err := bot.Subscribe(context.Background(), nil); publicError(err).Code != "invalid_argument" {
			t.Fatal("bot did not validate callback subscription")
		}
		must(t, bot.Close())
	}
}
func TestProviderCredentialReplacementAndDuplicateBotValidation(t *testing.T) {
	c := testCore(t, nil)
	c.cancel()
	one := ProviderConfig{ID: "one", Name: "First", Type: "feishu", AppID: "same-app", AppSecret: "first-secret", Enabled: true}
	raw, _ := json.Marshal(one)
	_, err := c.SaveProvider(raw)
	must(t, err)
	_, err = c.SaveProvider(json.RawMessage(`{"id":"one","name":"Changed","type":"feishu","enabled":false,"app_id":"new-app","app_secret":""}`))
	if publicError(err).Code != "conflict" {
		t.Fatal("existing provider app ID was changed")
	}
	if c.store.Snapshot().Providers["one"].AppID != "same-app" {
		t.Fatal("invalid credentials partially applied")
	}
	two := one
	two.ID = "two"
	two.Name = "Second"
	two.AppSecret = "second-secret"
	raw, _ = json.Marshal(two)
	_, err = c.SaveProvider(raw)
	if publicError(err).Code != "conflict" {
		t.Fatal("duplicate active WebSocket bot accepted")
	}
	doc, _ := json.Marshal(Backup{Version: 1, Providers: []ProviderConfig{one, two}, Default: "one", Remote: c.store.Snapshot().Remote})
	if err = c.ImportConfig(doc); publicError(err).Code != "conflict" {
		t.Fatal("backup enabled duplicate WebSocket receivers")
	}
	two.Enabled = false
	raw, _ = json.Marshal(two)
	_, err = c.SaveProvider(raw)
	must(t, err)
}

type importTestBot struct {
	Bot
	closes int
}

func (p *importTestBot) Close() error { p.closes++; return p.Bot.Close() }

func TestImportRejectsProviderTypeChangesWithoutSideEffects(t *testing.T) {
	for _, oldType := range []string{"feishu", "remote"} {
		for _, bound := range []bool{false, true} {
			for _, enabled := range []bool{false, true} {
				name := oldType
				if bound {
					name += "/bound"
				} else {
					name += "/unbound"
				}
				if enabled {
					name += "/enabled"
				} else {
					name += "/disabled"
				}
				t.Run(name, func(t *testing.T) {
					c := testCore(t, nil)
					bot := &importTestBot{Bot: installFake(t, c, "retained")}
					installRoutingBot(c, "retained", bot)
					c.setStatus("retained", "connected")
					if bound {
						_, err := c.Ensure(context.Background(), "retained", Session{Adapter: "codex", SessionID: "bound"})
						must(t, err)
					}
					removed := ProviderConfig{ID: "removed", Name: "Removed", Type: "feishu", AppID: "other-app", AppSecret: "synthetic", Enabled: false}
					must(t, c.store.Update(func(d *State) error {
						p := d.Providers["retained"]
						p.Type, p.Enabled = oldType, enabled
						p.Address, p.Token = "127.0.0.1:1", "synthetic"
						d.Providers[p.ID] = p
						d.Providers[removed.ID] = removed
						s := Session{NodeID: d.NodeID, Adapter: "codex", SessionID: "would-be-retired"}
						d.Bindings[s.key()] = Binding{ProviderID: removed.ID, Session: s, ChatID: "keep-group"}
						return nil
					}))
					testServer(t, c)
					before := c.store.Snapshot()
					statePath := filepath.Join(c.store.dir, "state.json")
					fileBefore, err := os.ReadFile(statePath)
					must(t, err)
					p := before.Providers["retained"]
					p.Type = "remote"
					if oldType == "remote" {
						p.Type = "feishu"
					}
					// The same backup also removes a bound provider, changes the
					// default, and disables the listener. None may apply on conflict.
					raw, err := json.Marshal(Backup{Version: 1, Providers: []ProviderConfig{p}, Remote: RemoteConfig{Listen: "127.0.0.1:0"}})
					must(t, err)
					c.mu.Lock()
					server := c.server
					c.mu.Unlock()
					// Keep even a regressed enabled import from contacting Feishu.
					c.cancel()
					if err := c.ImportConfig(raw); publicError(err).Code != "conflict" {
						t.Fatalf("provider type change returned %v; want conflict", err)
					}
					if !reflect.DeepEqual(before, c.store.Snapshot()) {
						t.Fatal("rejected import changed durable state")
					}
					fileAfter, err := os.ReadFile(statePath)
					must(t, err)
					if !bytes.Equal(fileBefore, fileAfter) {
						t.Fatal("rejected import rewrote the state file")
					}
					c.mu.Lock()
					unchanged := c.providers["retained"] == bot && c.statuses["retained"] == "connected" && c.server == server
					c.mu.Unlock()
					if !unchanged || bot.closes != 0 {
						t.Fatal("rejected import restarted a provider or listener")
					}
				})
			}
		}
	}
}

func TestImportAllowsSameProviderTypeAndNewIDs(t *testing.T) {
	for _, providerType := range []string{"feishu", "remote"} {
		t.Run(providerType, func(t *testing.T) {
			c := testCore(t, nil)
			installFake(t, c, "retained")
			_, err := c.Ensure(context.Background(), "retained", Session{Adapter: "codex", SessionID: "bound"})
			must(t, err)
			must(t, c.store.Update(func(d *State) error {
				p := d.Providers["retained"]
				p.Type, p.Address, p.Token = providerType, "127.0.0.1:1", "synthetic"
				d.Providers[p.ID] = p
				return nil
			}))
			before := c.store.Snapshot()
			p := before.Providers["retained"]
			p.Name = "Updated configuration"
			p.AppSecret, p.Token = "updated-synthetic-secret", "updated-synthetic-token"
			added := ProviderConfig{ID: "new", Name: "New", Type: "remote", Address: "127.0.0.1:2", Token: "synthetic"}
			if providerType == "remote" {
				added.Type, added.AppID, added.AppSecret = "feishu", "new-app", "synthetic"
			}
			raw, err := json.Marshal(Backup{Version: 1, Providers: []ProviderConfig{p, added}, Default: added.ID, Remote: before.Remote})
			must(t, err)
			must(t, c.ImportConfig(raw))
			after := c.store.Snapshot()
			if after.Providers[p.ID] != p || after.Providers[added.ID] != added || after.DefaultProvider != added.ID || !reflect.DeepEqual(after.Bindings, before.Bindings) {
				t.Fatal("same-type update or new provider import lost configuration or bindings")
			}
		})
	}
}

func TestProviderConnectionTypeSaveRetention(t *testing.T) {
	for _, connectionType := range []FeishuConnectionType{"", FeishuConnectionBot, FeishuConnectionPersonalApp} {
		t.Run("subtype="+string(connectionType), func(t *testing.T) {
			c := testCore(t, nil)
			p := ProviderConfig{ID: "feishu", Name: "Original", Type: "feishu", ConnectionType: connectionType, AppID: "app", AppSecret: "synthetic", Recipient: "recipient"}
			raw, err := json.Marshal(p)
			must(t, err)
			initial, err := c.SaveProvider(raw)
			must(t, err)
			wantSummary := connectionType
			if wantSummary == "" {
				wantSummary = FeishuConnectionBot
			}
			if initial.Type != "feishu" || initial.ConnectionType != wantSummary {
				t.Fatalf("unexpected initial summary: %+v", initial)
			}
			updated, err := c.SaveProvider(json.RawMessage(`{"id":"feishu","name":"Renamed","type":"feishu","enabled":false,"app_id":"app","app_secret":"","recipient_open_id":"recipient"}`))
			must(t, err)
			p.Name = "Renamed"
			if got := c.store.Snapshot().Providers[p.ID]; got != p {
				t.Fatalf("masked update changed stored subtype or credentials: %+v", got)
			}
			if updated.ConnectionType != wantSummary || c.Status()["providers"].([]ProviderSummary)[0].ConnectionType != wantSummary {
				t.Fatal("public summaries lost the Feishu connection type")
			}
			// Explicit edits remain possible after an older client omits the field.
			p.ConnectionType = FeishuConnectionPersonalApp
			if connectionType == FeishuConnectionPersonalApp {
				p.ConnectionType = FeishuConnectionBot
			}
			raw, err = json.Marshal(p)
			must(t, err)
			updated, err = c.SaveProvider(raw)
			must(t, err)
			if updated.ConnectionType != p.ConnectionType || c.store.Snapshot().Providers[p.ID] != p {
				t.Fatal("explicit connection type update was not persisted")
			}
		})
	}
}

func TestProviderConnectionTypeBackupRoundTrip(t *testing.T) {
	source := testCore(t, nil)
	providers := []ProviderConfig{
		{ID: "old", Name: "Older Feishu", Type: "feishu", AppID: "old", AppSecret: "synthetic-old"},
		{ID: "bot", Name: "Bot", Type: "feishu", ConnectionType: FeishuConnectionBot, AppID: "bot", AppSecret: "synthetic-bot"},
		{ID: "personal", Name: "Personal", Type: "feishu", ConnectionType: FeishuConnectionPersonalApp, AppID: "personal", AppSecret: "synthetic-personal"},
		{ID: "remote", Name: "Remote", Type: "remote", Address: "127.0.0.1:1", Token: "synthetic-remote"},
	}
	for _, p := range providers {
		raw, err := json.Marshal(p)
		must(t, err)
		_, err = source.SaveProvider(raw)
		must(t, err)
	}
	raw, err := json.Marshal(source.ExportConfig())
	must(t, err)
	target := testCore(t, nil)
	must(t, target.ImportConfig(raw))
	before, after := source.store.Snapshot(), target.store.Snapshot()
	if !reflect.DeepEqual(before.Providers, after.Providers) || before.DefaultProvider != after.DefaultProvider {
		t.Fatal("config export/import did not retain optional connection types")
	}
	for _, p := range target.ExportConfig().Providers {
		raw, err := json.Marshal(p)
		must(t, err)
		var fields map[string]any
		must(t, json.Unmarshal(raw, &fields))
		if _, present := fields["connection_type"]; present != (p.ConnectionType != "") {
			t.Fatal("backup filled in a missing connection type")
		}
	}
	for _, p := range target.Status()["providers"].([]ProviderSummary) {
		raw, err := json.Marshal(p)
		must(t, err)
		var fields map[string]any
		must(t, json.Unmarshal(raw, &fields))
		if p.Type == "remote" {
			if _, present := fields["connection_type"]; present {
				t.Fatal("remote summary exposed a Feishu connection type")
			}
		} else if p.ConnectionType != FeishuConnectionBot && p.ConnectionType != FeishuConnectionPersonalApp {
			t.Fatal("Feishu summary omitted its connection type")
		}
	}
}

func TestProviderConnectionTypeRejectsInvalidValues(t *testing.T) {
	cases := []struct {
		name         string
		providerType string
		value        any
	}{
		{"unknown", "feishu", "personal"},
		{"case", "feishu", "BOT"},
		{"empty", "feishu", ""},
		{"null", "feishu", nil},
		{"number", "feishu", 1},
		{"boolean", "feishu", false},
		{"object", "feishu", map[string]any{"type": "bot"}},
		{"remote-bot", "remote", "bot"},
		{"remote-personal", "remote", "personal-app"},
	}
	for _, tc := range cases {
		for _, method := range []string{"provider.save", "config.import", "migration.import"} {
			if method == "migration.import" && tc.providerType != "feishu" {
				continue
			}
			t.Run(tc.name+"/"+method, func(t *testing.T) {
				c := testCore(t, nil)
				c.cancel() // Invalid migrations must never contact real Feishu, even on regression.
				before := c.store.Snapshot()
				statePath := filepath.Join(c.store.dir, "state.json")
				fileBefore, err := os.ReadFile(statePath)
				must(t, err)
				p := map[string]any{"id": "invalid", "name": "Invalid", "type": tc.providerType, "connection_type": tc.value, "enabled": false, "app_id": "app", "app_secret": "synthetic", "address": "127.0.0.1:1", "token": "synthetic"}
				var input any = p
				if method == "config.import" {
					input = map[string]any{"version": 1, "providers": []any{p}, "remote": before.Remote}
				}
				raw, err := json.Marshal(input)
				must(t, err)
				_, err = c.Handle(context.Background(), method, raw, true)
				if publicError(err).Code != "invalid_argument" {
					t.Fatalf("invalid connection type returned %v", err)
				}
				fileAfter, err := os.ReadFile(statePath)
				must(t, err)
				if !reflect.DeepEqual(before, c.store.Snapshot()) || !bytes.Equal(fileBefore, fileAfter) {
					t.Fatal("invalid connection type changed durable state")
				}
			})
		}
	}
}

func TestPeerConnectedStatusTracksSubscriptionLifetime(t *testing.T) {
	c := testCore(t, nil)
	sub, err := c.Subscribe(context.Background(), "peer", "downstream")
	must(t, err)
	remote := c.Status()["remote"].(RemoteSummary)
	if len(remote.Peers) != 1 || !remote.Peers[0].Connected {
		t.Fatal("active peer reported disconnected")
	}
	sub.Close()
	remote = c.Status()["remote"].(RemoteSummary)
	if len(remote.Peers) != 1 || remote.Peers[0].Connected {
		t.Fatal("offline peer missing or reported connected")
	}
	sub, err = c.Subscribe(context.Background(), "peer", "downstream")
	must(t, err)
	defer sub.Close()
	if !c.Status()["remote"].(RemoteSummary).Peers[0].Connected {
		t.Fatal("reconnected peer reported disconnected")
	}
}
func TestTombstoneSuppressesQueuedReplayAndPreviousActivationRetry(t *testing.T) {
	count := 0
	delivery := ""
	c := testCore(t, func(event string, data any) error {
		if event == "delivery" {
			count++
			delivery = data.(map[string]any)["delivery_id"].(string)
		}
		return nil
	})
	installFake(t, c, "bot")
	sub, err := c.Subscribe(context.Background(), "offline", "")
	must(t, err)
	sub.Close()
	queued := eventFor("other-owner", "queued-before-delete")
	must(t, c.Ingest(context.Background(), queued, ""))
	must(t, c.Delete(context.Background(), "", queued.Session))
	if len(c.store.Snapshot().Peers["offline"].Pending) != 0 {
		t.Fatal("deleted session remained in downstream replay queue")
	}
	local := eventFor(c.node(), "retry-before-delete")
	must(t, c.Ingest(context.Background(), local, ""))
	must(t, c.Complete(delivery, "retryable", "offline", ""))
	must(t, c.Delete(context.Background(), "", local.Session))
	_, err = c.Ensure(context.Background(), "bot", local.Session)
	must(t, err)
	if err = c.RetryDelivery(delivery); publicError(err).Code != "deleted" {
		t.Fatal("reactivation replayed a previous activation's command")
	}
	must(t, c.Ingest(context.Background(), local, ""))
	if count != 1 {
		t.Fatal("old source replay delivered after reactivation")
	}
}

func TestMigrationConnectionTypeInitialImport(t *testing.T) {
	for _, connectionType := range []FeishuConnectionType{"", FeishuConnectionBot, FeishuConnectionPersonalApp} {
		t.Run("subtype="+string(connectionType), func(t *testing.T) {
			c := testCore(t, nil)
			c.cancel()
			raw, err := json.Marshal(migration{AppID: "app", AppSecret: "synthetic", ConnectionType: connectionType})
			must(t, err)
			result, err := c.Handle(context.Background(), "migration.import", raw, true)
			must(t, err)
			p := c.store.Snapshot().Providers["legacy-feishu"]
			if result.(map[string]any)["imported"] != true || p.Type != "feishu" || p.ConnectionType != connectionType {
				t.Fatalf("initial migration did not persist the optional subtype: %+v", p)
			}
		})
	}
}

func TestMigrationConnectionTypeInitialImportPreservesEnabledOwner(t *testing.T) {
	c := testCore(t, nil)
	bot := &importTestBot{Bot: installFake(t, c, "active")}
	installRoutingBot(c, "active", bot)
	c.setStatus("active", "connected")
	_, err := c.Ensure(context.Background(), "active", Session{Adapter: "codex", SessionID: "retained"})
	must(t, err)
	must(t, c.store.Update(func(d *State) error {
		p := d.Providers["active"]
		p.Name, p.Recipient, p.Enabled = "Current owner", "current-recipient", true
		d.Providers[p.ID] = p
		return nil
	}))
	before := c.store.Snapshot()
	if before.Migrated || before.Providers["legacy-feishu"].ID != "" || before.Providers["active"].ConnectionType != "" {
		t.Fatal("fixture must start before migration with an untyped enabled owner")
	}
	c.cancel() // A regression must never connect to real Feishu.
	raw := json.RawMessage(`{"app_id":"app","app_secret":"legacy-secret","recipient_open_id":"legacy-recipient","connection_type":"personal-app","bindings":[{"chat_id":"imported-chat","session_id":"imported","adapter":"codex"}]}`)
	result, err := c.Migrate(raw)
	must(t, err)
	after := c.store.Snapshot()
	wantOwner := before.Providers["active"]
	wantOwner.ConnectionType = FeishuConnectionPersonalApp
	if result["imported"] != true || !after.Migrated || after.Providers["active"] != wantOwner {
		t.Fatal("initial migration lost the existing owner's subtype backfill or changed its config")
	}
	legacy := after.Providers["legacy-feishu"]
	if legacy.ID != "legacy-feishu" || legacy.Type != "feishu" || legacy.Enabled || legacy.ConnectionType != FeishuConnectionPersonalApp {
		t.Fatal("initial migration did not retain a separate disabled legacy provider with its subtype")
	}
	if after.DefaultProvider != before.DefaultProvider || c.providers["active"] != bot || bot.closes != 0 || c.statuses["active"] != "connected" {
		t.Fatal("initial migration replaced or restarted the enabled owner")
	}
	for key, binding := range before.Bindings {
		if !reflect.DeepEqual(binding, after.Bindings[key]) {
			t.Fatal("initial migration changed an existing binding")
		}
	}
	key := (Session{NodeID: c.node(), Adapter: "codex", SessionID: "imported"}).key()
	if binding := after.Bindings[key]; binding.ProviderID != "active" || binding.ChatID != "imported-chat" {
		t.Fatal("initial migration did not route the imported binding through its enabled owner")
	}
	raw, err = os.ReadFile(filepath.Join(c.store.dir, "state.json"))
	must(t, err)
	var persisted State
	must(t, json.Unmarshal(raw, &persisted))
	if persisted.Providers["active"] != wantOwner || persisted.Providers["legacy-feishu"] != legacy {
		t.Fatal("initial migration overwrote a connection type while persisting the providers")
	}
}

func TestMigrationConnectionTypeBackfillPreservesExistingState(t *testing.T) {
	cases := []struct {
		name      string
		id        string
		migrated  bool
		tombstone bool
	}{
		{"migrated-legacy", "legacy-feishu", true, false},
		{"existing-legacy", "legacy-feishu", false, false},
		{"migrated-other-id", "current", true, false},
		{"deleted-legacy", "current", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := testCore(t, nil)
			bot := &importTestBot{Bot: installFake(t, c, tc.id)}
			installRoutingBot(c, tc.id, bot)
			c.setStatus(tc.id, "connected")
			_, err := c.Ensure(context.Background(), tc.id, Session{Adapter: "codex", SessionID: "retained"})
			must(t, err)
			must(t, c.store.Update(func(d *State) error {
				d.Migrated = tc.migrated
				d.ProviderTombstones["legacy-feishu"] = tc.tombstone
				d.DefaultProvider = "" // The user deliberately cleared their default.
				p := d.Providers[tc.id]
				p.Name, p.Recipient = "User-chosen name", "current-recipient"
				p.Enabled = tc.migrated
				d.Providers[p.ID] = p
				for _, explicit := range []FeishuConnectionType{FeishuConnectionBot, FeishuConnectionPersonalApp} {
					p.ID, p.ConnectionType = string(explicit), explicit
					d.Providers[p.ID] = p
				}
				p.ID, p.AppID, p.ConnectionType = "other-app", "different-app", ""
				d.Providers[p.ID] = p
				p.ID, p.Type, p.AppID = "remote", "remote", "app"
				d.Providers[p.ID] = p
				p.ID, p.Type = "tombstoned", "feishu"
				d.Providers[p.ID] = p
				d.ProviderTombstones[p.ID] = true
				s := Session{NodeID: d.NodeID, Adapter: "codex", SessionID: "deleted"}
				d.Bindings[s.key()] = Binding{ProviderID: tc.id, Session: s, ChatID: "deleted-chat", Deleted: true}
				d.FeishuCursors[feishuCursorKey("app", "deleted-chat")] = 1700000000000
				return nil
			}))
			before := c.store.Snapshot()
			raw := json.RawMessage(`{"app_id":"app","app_secret":"stale-secret","recipient_open_id":"stale-recipient","connection_type":"personal-app","legacy_host":"old","bindings":[{"chat_id":"deleted-chat","session_id":"deleted","adapter":"codex"},{"chat_id":"unexpected-chat","session_id":"unexpected"}]}`)
			_, err = c.Handle(context.Background(), "migration.import", raw, false)
			if publicError(err).Code != "permission_denied" || !reflect.DeepEqual(before, c.store.Snapshot()) {
				t.Fatal("remote migration was allowed to change provider metadata")
			}
			result, err := c.Handle(context.Background(), "migration.import", raw, true)
			must(t, err)
			if result.(map[string]any)["imported"] != false {
				t.Fatal("metadata backfill reported a new legacy import")
			}
			p := before.Providers[tc.id]
			p.ConnectionType = FeishuConnectionPersonalApp
			before.Providers[p.ID] = p
			if !reflect.DeepEqual(before, c.store.Snapshot()) {
				t.Fatal("backfill changed state other than the missing same-app subtype")
			}
			if c.providers[tc.id] != bot || bot.closes != 0 || c.statuses[tc.id] != "connected" {
				t.Fatal("metadata backfill restarted the provider")
			}
			statePath := filepath.Join(c.store.dir, "state.json")
			fileBefore, err := os.ReadFile(statePath)
			must(t, err)
			var persisted State
			must(t, json.Unmarshal(fileBefore, &persisted))
			if persisted.Providers[tc.id].ConnectionType != FeishuConnectionPersonalApp {
				t.Fatal("metadata backfill was not persisted to disk")
			}
			// A later migration cannot override the newly explicit personal-app choice.
			_, err = c.Migrate(json.RawMessage(`{"app_id":"app","app_secret":"stale-secret","connection_type":"bot"}`))
			must(t, err)
			fileAfter, err := os.ReadFile(statePath)
			must(t, err)
			if !reflect.DeepEqual(before, c.store.Snapshot()) || !bytes.Equal(fileBefore, fileAfter) {
				t.Fatal("repeat migration overwrote an explicit subtype or rewrote unchanged state")
			}
		})
	}
}

func TestMigrationConnectionTypeDoesNotResurrectDeletedProvider(t *testing.T) {
	c := testCore(t, nil)
	c.cancel()
	_, err := c.Migrate(json.RawMessage(`{"app_id":"app","app_secret":"synthetic"}`))
	must(t, err)
	must(t, c.DeleteProvider("legacy-feishu"))
	before := c.store.Snapshot()
	_, err = c.Migrate(json.RawMessage(`{"app_id":"app","app_secret":"synthetic","connection_type":"personal-app"}`))
	must(t, err)
	if !reflect.DeepEqual(before, c.store.Snapshot()) || before.DefaultProvider != "" {
		t.Fatal("subtype backfill resurrected a deleted provider or its default")
	}
}

func TestMigrationPreservesActualLegacyBindingShape(t *testing.T) {
	c := testCore(t, nil)
	c.cancel()
	raw := json.RawMessage(`{"app_id":"legacy","app_secret":"secret","legacy_host":"old","bindings":[{"chat_id":"one","session_id":"local_0123","metadata":"announcement","sender_open_id":"trusted-one","registration_message_id":"retained-id","pin":true},{"chat_id":"two","session_id":"ses_0123","metadata":"message","sender_open_id":"trusted-two"}]}`)
	_, err := c.Migrate(raw)
	must(t, err)
	d := c.store.Snapshot()
	one := d.Bindings[(Session{NodeID: c.node(), Adapter: "claude-desktop", SessionID: "local_0123"}).key()]
	two := d.Bindings[(Session{NodeID: c.node(), Adapter: "opencode", SessionID: "ses_0123"}).key()]
	if one.SenderID != "trusted-one" || two.SenderID != "trusted-two" || one.Session.Metadata["legacy_metadata"] != "announcement" || one.Session.Metadata["legacy_registration_message_id"] != "retained-id" {
		t.Fatal("legacy binding metadata or trusted sender was lost")
	}
}
