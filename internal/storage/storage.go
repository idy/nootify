// Package storage opens the existing Nootify SQLite state without translating or
// discarding opaque rows. Every mutation commits before becoming visible.
package storage

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const SchemaVersion = 4

var Tables = []string{"sessions", "lark_bindings", "backends", "lark_deliveries", "lark_poll_cursors", "chat_bindings", "chat_deliveries", "inbox_messages", "settings", "lark_poll_receipts", "session_observations", "telegram_clients"}

type Row struct {
	ID    string
	Value json.RawMessage
}
type Store struct {
	Directory string
	Token     string
	db        *sql.DB
}
type Tx struct{ tx *sql.Tx }
type queryer interface {
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
	Exec(string, ...any) (sql.Result, error)
}

func DefaultDir() string {
	if dir := os.Getenv("NOOTIFY_STATE_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return filepath.Join(dir, "Nootify", "state")
		}
		return filepath.Join(home, "AppData", "Local", "Nootify", "state")
	}
	if dir := os.Getenv("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "nootify")
	}
	return filepath.Join(home, ".local", "state", "nootify")
}
func Open(directory string) (s *Store, err error) {
	if directory == "" {
		directory = DefaultDir()
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if err = os.Chmod(directory, 0700); err != nil {
		return nil, err
	}
	token, err := privateToken(filepath.Join(directory, "auth-token"))
	if err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "state.sqlite")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	err = f.Chmod(0600)
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	defer func() {
		if err != nil {
			_ = db.Close()
		}
	}()
	for _, q := range []string{"PRAGMA busy_timeout=5000", "PRAGMA synchronous=FULL", "PRAGMA foreign_keys=ON"} {
		if _, err = db.Exec(q); err != nil {
			return nil, err
		}
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return nil, err
	}
	if version > SchemaVersion {
		return nil, errors.New("the state database requires a newer Nootify version")
	}
	var legacy map[string]json.RawMessage
	if version == 0 {
		legacy, err = readLegacy(filepath.Join(directory, "state.json"))
		if err != nil {
			return nil, err
		}
	}
	if _, err = db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, err
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return nil, err
	}
	if version > SchemaVersion {
		return nil, errors.New("the state database requires a newer Nootify version")
	}
	if version < SchemaVersion {
		for _, table := range Tables {
			_, err = tx.Exec(`CREATE TABLE IF NOT EXISTS ` + table + ` (id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),position INTEGER NOT NULL) STRICT`)
			if err != nil {
				return nil, err
			}
			if _, err = tx.Exec(`CREATE INDEX IF NOT EXISTS ` + table + `_position ON ` + table + ` (position)`); err != nil {
				return nil, err
			}
		}
		if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL) STRICT`); err != nil {
			return nil, err
		}
		if version == 0 && legacy != nil {
			if err = importLegacy(&Tx{tx}, legacy); err != nil {
				return nil, err
			}
		}
		if version < 2 {
			if err = migrateReceipts(&Tx{tx}); err != nil {
				return nil, err
			}
		}
		for v := version + 1; v <= SchemaVersion; v++ {
			if _, err = tx.Exec("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)", v, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
				return nil, err
			}
		}
		if _, err = tx.Exec("PRAGMA user_version=4"); err != nil {
			return nil, err
		}
	}
	// A released database must contain every known table. Never reset a corrupt database.
	for _, table := range Tables {
		var count int
		if err = tx.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil {
			return nil, fmt.Errorf("invalid service state %s: %w", table, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return &Store{Directory: directory, Token: token, db: db}, nil
}
func privateToken(path string) (string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key := make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return "", err
		}
		// Publish only a complete, synced token. An exclusive hard link keeps
		// concurrent creators from replacing the winner or observing an empty file.
		f, e := os.CreateTemp(filepath.Dir(path), ".auth-token-*")
		if e != nil {
			return "", e
		}
		temporary := f.Name()
		defer os.Remove(temporary)
		_, e = f.WriteString(hex.EncodeToString(key))
		if e == nil {
			e = f.Sync()
		}
		if closeErr := f.Close(); e == nil {
			e = closeErr
		}
		if e != nil {
			return "", e
		}
		if e = os.Link(temporary, path); e != nil && !errors.Is(e, os.ErrExist) {
			return "", e
		}
		b, err = os.ReadFile(path)
	}
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(string(b))
	decoded, err := hex.DecodeString(s)
	if err != nil || len(decoded) != 32 || s != strings.ToLower(s) {
		return "", errors.New("invalid private service authentication file")
	}
	return s, nil
}
func tableName(table string) error {
	for _, t := range Tables {
		if t == table {
			return nil
		}
	}
	return fmt.Errorf("unknown state table %q", table)
}
func get(q queryer, table, id string, out any) (bool, error) {
	if err := tableName(table); err != nil {
		return false, err
	}
	var raw string
	err := q.QueryRow("SELECT value FROM "+table+" WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if out == nil {
		return true, nil
	}
	if err = json.Unmarshal([]byte(raw), out); err != nil {
		return false, fmt.Errorf("invalid %s row: %w", table, err)
	}
	return true, nil
}
func rows(q queryer, table string) ([]Row, error) {
	if err := tableName(table); err != nil {
		return nil, err
	}
	r, err := q.Query("SELECT id,value FROM " + table + " ORDER BY position,id")
	if err != nil {
		return nil, err
	}
	defer r.Close()
	result := []Row{}
	for r.Next() {
		var row Row
		var raw string
		if err = r.Scan(&row.ID, &raw); err != nil {
			return nil, err
		}
		if !json.Valid([]byte(raw)) {
			return nil, errors.New("invalid JSON in state database")
		}
		row.Value = json.RawMessage(raw)
		result = append(result, row)
	}
	return result, r.Err()
}
func put(q queryer, table, id string, value any) error {
	if err := tableName(table); err != nil {
		return err
	}
	if id == "" {
		return errors.New("state row identity is empty")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = q.Exec("INSERT INTO "+table+" (id,value,position) VALUES(?,?,(SELECT coalesce(max(position),-1)+1 FROM "+table+")) ON CONFLICT(id) DO UPDATE SET value=excluded.value", id, string(raw))
	return err
}
func del(q queryer, table, id string) error {
	if err := tableName(table); err != nil {
		return err
	}
	_, err := q.Exec("DELETE FROM "+table+" WHERE id=?", id)
	return err
}
func (s *Store) Get(table, id string, out any) (bool, error) { return get(s.db, table, id, out) }
func (s *Store) Rows(table string) ([]Row, error)            { return rows(s.db, table) }
func (s *Store) Put(table, id string, value any) error {
	return s.Update(func(tx *Tx) error { return tx.Put(table, id, value) })
}
func (s *Store) Delete(table, id string) error {
	return s.Update(func(tx *Tx) error { return tx.Delete(table, id) })
}
func (s *Store) Update(fn func(*Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(&Tx{tx}); err != nil {
		return err
	}
	return tx.Commit()
}
func (tx *Tx) Get(table, id string, out any) (bool, error) { return get(tx.tx, table, id, out) }
func (tx *Tx) Rows(table string) ([]Row, error)            { return rows(tx.tx, table) }
func (tx *Tx) Put(table, id string, value any) error       { return put(tx.tx, table, id, value) }
func (tx *Tx) Delete(table, id string) error               { return del(tx.tx, table, id) }
func (s *Store) Setting(key string) string {
	var value string
	_, _ = s.Get("settings", key, &value)
	return value
}
func (s *Store) BoolSetting(key string, fallback bool) bool {
	var value bool
	ok, err := s.Get("settings", key, &value)
	if err != nil || !ok {
		return fallback
	}
	return value
}
func (s *Store) SetSettings(values map[string]any) error {
	return s.Update(func(tx *Tx) error {
		for key, value := range values {
			if value == nil {
				if err := tx.Delete("settings", key); err != nil {
					return err
				}
			} else if err := tx.Put("settings", key, value); err != nil {
				return err
			}
		}
		return nil
	})
}
func (s *Store) Close() error { return s.db.Close() }
func readLegacy(path string) (map[string]json.RawMessage, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return nil, errors.New("invalid legacy state JSON; the original file was not replaced")
	}
	var version int
	if json.Unmarshal(result["version"], &version) != nil || version != 1 {
		return nil, errors.New("invalid legacy state version")
	}
	for _, key := range []string{"sessions", "lark_bindings"} {
		var records []json.RawMessage
		if json.Unmarshal(result[key], &records) != nil || records == nil {
			return nil, fmt.Errorf("invalid legacy %s", key)
		}
	}
	return result, nil
}
func importLegacy(tx *Tx, legacy map[string]json.RawMessage) error {
	for _, table := range Tables {
		raw, ok := legacy[table]
		if !ok {
			continue
		}
		if table == "settings" {
			var settings map[string]json.RawMessage
			if json.Unmarshal(raw, &settings) != nil || settings == nil {
				return errors.New("invalid legacy settings")
			}
			for key, v := range settings {
				if err := tx.Put(table, key, v); err != nil {
					return err
				}
			}
			continue
		}
		if table == "backends" {
			var records [][]json.RawMessage
			if err := json.Unmarshal(raw, &records); err != nil {
				return err
			}
			for _, pair := range records {
				if len(pair) != 2 {
					return errors.New("invalid legacy backend")
				}
				var id string
				if json.Unmarshal(pair[0], &id) != nil {
					return errors.New("invalid legacy backend identity")
				}
				if err := tx.Put(table, id, pair[1]); err != nil {
					return err
				}
			}
			continue
		}
		var records []map[string]json.RawMessage
		if err := json.Unmarshal(raw, &records); err != nil {
			return err
		}
		for _, record := range records {
			key := "id"
			switch table {
			case "sessions", "session_observations":
				key = "session_id"
			case "lark_bindings":
				key = "chat_id"
			case "lark_deliveries":
				key = "message_id"
			case "telegram_clients":
				key = "key"
			}
			var id string
			_ = json.Unmarshal(record[key], &id)
			switch table {
			case "session_observations":
				var adapter string
				_ = json.Unmarshal(record["adapter"], &adapter)
				id = adapter + ":" + id
			case "lark_poll_cursors":
				var app, kind, container string
				_ = json.Unmarshal(record["app_id"], &app)
				_ = json.Unmarshal(record["container_type"], &kind)
				_ = json.Unmarshal(record["container_id"], &container)
				if app == "" || kind == "" || container == "" {
					return errors.New("invalid legacy poll cursor")
				}
				id = app + ":" + kind + ":" + container
			case "lark_poll_receipts":
				var cursor, message string
				_ = json.Unmarshal(record["cursor_id"], &cursor)
				_ = json.Unmarshal(record["message_id"], &message)
				if cursor == "" || message == "" {
					return errors.New("invalid legacy poll receipt")
				}
				key, _ := json.Marshal([]string{cursor, message})
				id = string(key)
			}
			if id == "" {
				return fmt.Errorf("invalid legacy %s identity", table)
			}
			if err := tx.Put(table, id, record); err != nil {
				return err
			}
		}
	}
	return nil
}
func migrateReceipts(tx *Tx) error {
	records, err := tx.Rows("lark_poll_cursors")
	if err != nil {
		return err
	}
	for _, row := range records {
		var cursor map[string]json.RawMessage
		if err = json.Unmarshal(row.Value, &cursor); err != nil {
			return err
		}
		recent, exists := cursor["recent"]
		if !exists {
			continue
		}
		var pairs [][]json.RawMessage
		if err = json.Unmarshal(recent, &pairs); err != nil {
			return err
		}
		for _, pair := range pairs {
			if len(pair) != 2 {
				return errors.New("invalid legacy poll receipt")
			}
			var id string
			var created int64
			if json.Unmarshal(pair[0], &id) != nil || id == "" || json.Unmarshal(pair[1], &created) != nil {
				return errors.New("invalid legacy poll receipt")
			}
			key, _ := json.Marshal([]string{row.ID, id})
			if err = tx.Put("lark_poll_receipts", string(key), map[string]any{"cursor_id": row.ID, "message_id": id, "create_time": created}); err != nil {
				return err
			}
		}
		delete(cursor, "recent")
		if err = tx.Put("lark_poll_cursors", row.ID, cursor); err != nil {
			return err
		}
	}
	return nil
}

// WritePrivate replaces a private JSON/document file atomically and durably.
func WritePrivate(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".nootify-write-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	ce := f.Close()
	if err == nil {
		err = ce
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		dir, e := os.Open(filepath.Dir(path))
		if e != nil {
			return e
		}
		defer dir.Close()
		return dir.Sync()
	}
	return nil
}
