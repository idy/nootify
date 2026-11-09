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
