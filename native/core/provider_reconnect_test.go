package core

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReconnectProviderPreservesConfigurationAndDefault(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		for _, defaultID := range []string{"", "other"} {
			t.Run(map[bool]string{false: "disabled", true: "enabled"}[enabled]+"/default="+defaultID, func(t *testing.T) {
				c := testCore(t, nil)
				c.cancel() // No external provider requests are made by this fixture.
				previous := &importTestBot{Bot: installFake(t, c, "personal")}
				installRoutingBot(c, "personal", previous)
				installFake(t, c, "other")
				must(t, c.store.Update(func(d *State) error {
					p := d.Providers["personal"]
					p.Enabled, p.ConnectionType, p.Recipient = enabled, FeishuConnectionPersonalApp, "ou_saved"
					d.Providers[p.ID] = p
					d.DefaultProvider = defaultID
					return nil
				}))
				before := c.store.Snapshot()
				stateFile := filepath.Join(c.store.dir, "state.json")
				beforeBytes, err := os.ReadFile(stateFile)
				must(t, err)
				_, err = c.Handle(context.Background(), "provider.reconnect", json.RawMessage(`{"id":"personal"}`), false)
				if publicError(err).Code != "permission_denied" || previous.closes != 0 {
					t.Fatal("remote reconnect reached the provider")
				}
				result, err := c.Handle(context.Background(), "provider.reconnect", json.RawMessage(`{"id":"personal"}`), true)
				must(t, err)
				summary := result.(ProviderSummary)
				if summary.ID != "personal" || summary.ConnectionType != FeishuConnectionPersonalApp || summary.Enabled != enabled || !summary.SecretSet || previous.closes != 1 {
					t.Fatal("reconnect did not reuse the saved provider configuration")
				}
				wantStatus := "disabled"
				if enabled {
					wantStatus = "connecting"
				}
				if summary.Status != wantStatus {
					t.Fatalf("status = %q, want %q", summary.Status, wantStatus)
				}
				afterBytes, err := os.ReadFile(stateFile)
				must(t, err)
				if !reflect.DeepEqual(before, c.store.Snapshot()) || !bytes.Equal(beforeBytes, afterBytes) {
					t.Fatal("reconnect rewrote state or changed the default")
				}
			})
		}
	}
}

func TestReconnectProviderCannotResurrectDeletedConfiguration(t *testing.T) {
	c := testCore(t, nil)
	installFake(t, c, "deleted")
	must(t, c.DeleteProvider("deleted"))
	before := c.store.Snapshot()
	for _, id := range []string{"deleted", "missing", ""} {
		_, err := c.ReconnectProvider(id)
		want := "not_found"
		if id == "" {
			want = "invalid_argument"
		}
		if publicError(err).Code != want {
			t.Fatalf("reconnect %q: expected %s, got %v", id, want, err)
		}
	}
	if !reflect.DeepEqual(before, c.store.Snapshot()) {
		t.Fatal("failed reconnect changed stored configuration")
	}
}
