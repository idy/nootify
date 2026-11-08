package main

import (
	"context"
	"encoding/json"
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
	if publicError(err).Code != "invalid_argument" {
		t.Fatal("old app secret was reused with a different app ID")
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
