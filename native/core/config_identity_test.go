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

func TestFeishuApplicationIdentityIsImmutableForExistingProvider(t *testing.T) {
	for _, importing := range []bool{false, true} {
		for _, enabled := range []bool{false, true} {
			for _, bound := range []bool{false, true} {
				name := "save"
				if importing {
					name = "import"
				}
				if enabled {
					name += "/enabled"
				} else {
					name += "/disabled"
				}
				if bound {
					name += "/bound"
				} else {
					name += "/unbound"
				}
				t.Run(name, func(t *testing.T) {
					c := testCore(t, nil)
					bot := &importTestBot{Bot: installFake(t, c, "retained")}
					installRoutingBot(c, "retained", bot)
					c.setStatus("retained", "connected")
					if bound {
						_, err := c.Ensure(context.Background(), "retained", Session{Adapter: "codex", SessionID: "stable"})
						must(t, err)
					}
					must(t, c.store.Update(func(d *State) error {
						p := d.Providers["retained"]
						p.Enabled = enabled
						d.Providers[p.ID] = p
						return nil
					}))
					testServer(t, c)
					before := c.store.Snapshot()
					statePath := filepath.Join(c.store.dir, "state.json")
					fileBefore, err := os.ReadFile(statePath)
					must(t, err)
					server := c.server
					p := before.Providers["retained"]
					p.AppID, p.AppSecret = "another-app", "another-valid-secret"
					c.cancel() // Even a regression must never contact real Feishu.
					if importing {
						raw, err := json.Marshal(Backup{Version: 1, Providers: []ProviderConfig{p}, Remote: RemoteConfig{Listen: "127.0.0.1:0"}})
						must(t, err)
						err = c.ImportConfig(raw)
						if publicError(err).Code != "conflict" {
							t.Fatalf("changed app import returned %v", err)
						}
					} else {
						raw, err := json.Marshal(p)
						must(t, err)
						_, err = c.SaveProvider(raw)
						if publicError(err).Code != "conflict" {
							t.Fatalf("changed app save returned %v", err)
						}
					}
					fileAfter, err := os.ReadFile(statePath)
					must(t, err)
					if !reflect.DeepEqual(before, c.store.Snapshot()) || !bytes.Equal(fileBefore, fileAfter) {
						t.Fatal("app-ID conflict mutated durable config or routing state")
					}
					if c.server != server || c.providers["retained"] != bot || bot.closes != 0 {
						t.Fatal("app-ID conflict restarted live resources")
					}
				})
			}
		}
	}
}

func TestFeishuApplicationSecretRotationPreservesBinding(t *testing.T) {
	for _, importing := range []bool{false, true} {
		name := "save"
		if importing {
			name = "import"
		}
		t.Run(name, func(t *testing.T) {
			c := testCore(t, nil)
			installFake(t, c, "bot")
			_, err := c.Ensure(context.Background(), "bot", Session{Adapter: "codex", SessionID: "bound"})
			must(t, err)
			before := c.store.Snapshot()
			p := before.Providers["bot"]
			p.AppSecret, p.Enabled = "rotated-secret", false
			if importing {
				raw, err := json.Marshal(Backup{Version: 1, Providers: []ProviderConfig{p}, Remote: before.Remote})
				must(t, err)
				must(t, c.ImportConfig(raw))
			} else {
				raw, err := json.Marshal(p)
				must(t, err)
				_, err = c.SaveProvider(raw)
				must(t, err)
			}
			after := c.store.Snapshot()
			if after.Providers["bot"].AppSecret != p.AppSecret || !reflect.DeepEqual(before.Bindings, after.Bindings) || before.NodeID != after.NodeID {
				t.Fatal("secret rotation lost application or session identity")
			}
		})
	}
}
