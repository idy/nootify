package storage

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSQLitePreservesOpaqueStateAndRollsBack(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	unknown := json.RawMessage(`{"secret":"retired-value","nested":{"future":true}}`)
	if err = s.Put("telegram_clients", "opaque", unknown); err != nil {
		t.Fatal(err)
	}
	if err = s.SetSettings(map[string]any{"future_setting": map[string]any{"keep": true}, "github_token": "before"}); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("abort")
	err = s.Update(func(tx *Tx) error {
		if err := tx.Put("settings", "github_token", "after"); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) || s.Setting("github_token") != "before" {
		t.Fatalf("failed transaction was visible: %v", err)
	}
	var saved json.RawMessage
	ok, err := s.Get("telegram_clients", "opaque", &saved)
	if err != nil || !ok || string(saved) != string(unknown) {
		t.Fatalf("opaque state changed: %s %v", saved, err)
	}
	token := s.Token
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if again.Token != token || again.Setting("github_token") != "before" {
		t.Fatal("reopen lost identity or committed state")
	}
}
func TestInvalidLegacyCannotReplaceOriginal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	original := []byte(`{"version":1,"sessions":[{"bad":true}],"lark_bindings":[]}`)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err == nil {
		s.Close()
		t.Fatal("invalid legacy identity accepted")
	}
	saved, _ := os.ReadFile(path)
	if string(saved) != string(original) {
		t.Fatal("invalid legacy file replaced")
	}
	fixed := []byte(`{"version":1,"sessions":[{"session_id":"local_example","adapter":"claude-desktop"}],"lark_bindings":[],"settings":{"github_token":"saved"}}`)
	if err = os.WriteFile(path, fixed, 0600); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Setting("github_token") != "saved" {
		t.Fatal("legacy settings not imported after failed migration")
	}
}
func TestLegacyReceiptsMigrateWithCursorIdentity(t *testing.T) {
	dir := t.TempDir()
	raw := `{"version":1,"sessions":[],"lark_bindings":[],"lark_poll_cursors":[{"app_id":"cli_example","container_type":"chat","container_id":"oc_example","chat_id":"oc_example","started_at":1,"through":5,"recent":[["om_a",4]]}]}`
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rows, err := s.Rows("lark_poll_receipts")
	if err != nil || len(rows) != 1 {
		t.Fatalf("receipt lost: %+v %v", rows, err)
	}
	if rows[0].ID != `["cli_example:chat:oc_example","om_a"]` {
		t.Fatal(rows[0].ID)
	}
	cursor := map[string]any{}
	if _, err = s.Get("lark_poll_cursors", "cli_example:chat:oc_example", &cursor); err != nil {
		t.Fatal(err)
	}
	if _, ok := cursor["recent"]; ok {
		t.Fatal("inline legacy receipts retained")
	}
}
