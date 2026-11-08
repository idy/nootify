package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/gofrs/flock"
)

type State struct {
	Version            int                        `json:"version"`
	NodeID             string                     `json:"node_id"`
	Providers          map[string]ProviderConfig  `json:"providers"`
	ProviderTombstones map[string]bool            `json:"provider_tombstones"`
	DefaultProvider    string                     `json:"default_provider_id,omitempty"`
	Remote             RemoteConfig               `json:"remote"`
	Tailnet            bool                       `json:"tailnet_enabled"`
	Migrated           bool                       `json:"legacy_migrated"`
	Bindings           map[string]Binding         `json:"bindings"`
	Events             map[string]EventRecord     `json:"events"`
	BroadcastSequence  uint64                     `json:"broadcast_sequence,omitempty"`
	RetiredBindings    map[string]Binding         `json:"retired_bindings"`
	Deliveries         map[string]Delivery        `json:"deliveries"`
	References         map[string]ReferenceRecord `json:"references"`
	Peers              map[string]Peer            `json:"peers"`
	Operations         map[string]Operation       `json:"operations"`
}
type Store struct {
	mu    sync.Mutex
	state State
	dir   string
	lock  *flock.Flock
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("state directory must be a real directory")
	}
	if err = privateStatePath(dir, true); err != nil {
		return nil, err
	}
	lockPath := filepath.Join(dir, "core.lock")
	if _, e := os.Lstat(lockPath); e == nil {
		if e = privateStatePath(lockPath, false); e != nil {
			return nil, e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	lockFile, e := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	_ = lockFile.Close()
	if err = privateStatePath(lockPath, false); err != nil {
		return nil, err
	}
	l := flock.New(lockPath)
	ok, err := l.TryLock()
	if err != nil || !ok {
		return nil, fmt.Errorf("state directory is already in use")
	}
	_ = os.Chmod(filepath.Join(dir, "core.lock"), 0600)
	// An exclusive lock proves no current writer owns an abandoned temp file.
	entries, readErr := os.ReadDir(dir)
	if readErr != nil {
		l.Unlock()
		return nil, readErr
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".state-") {
			stale := filepath.Join(dir, entry.Name())
			if e := privateStatePath(stale, false); e != nil {
				l.Unlock()
				return nil, e
			}
			if e := os.Remove(stale); e != nil {
				l.Unlock()
				return nil, e
			}
		}
	}
	s := &Store{dir: dir, lock: l}
	path := filepath.Join(dir, "state.json")
	if i, e := os.Lstat(path); e == nil {
		if !i.Mode().IsRegular() || i.Size() > 64<<20 {
			l.Unlock()
			return nil, fmt.Errorf("invalid state file")
		}
		if err = privateStatePath(path, false); err != nil {
			l.Unlock()
			return nil, err
		}
	}
	b, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(b, &s.state)
		if err == nil && (s.state.Version != 1 || s.state.NodeID == "") {
			err = fmt.Errorf("unsupported or corrupt state")
		}
	} else if errors.Is(err, os.ErrNotExist) {
		s.state = State{Version: 1, NodeID: uid(), Remote: RemoteConfig{Listen: "127.0.0.1:9418"}}
		err = nil
	}
	if err != nil {
		l.Unlock()
		return nil, err
	}
	s.initMaps()
	if err = s.Update(func(*State) error { return nil }); err != nil {
		l.Unlock()
		return nil, err
	}
	return s, nil
}
func (s *Store) initMaps() {
	d := &s.state
	if d.Providers == nil {
		d.Providers = map[string]ProviderConfig{}
	}
	if d.ProviderTombstones == nil {
		d.ProviderTombstones = map[string]bool{}
	}
	if d.Bindings == nil {
		d.Bindings = map[string]Binding{}
	}
	if d.Events == nil {
		d.Events = map[string]EventRecord{}
	}
	if d.Deliveries == nil {
		d.Deliveries = map[string]Delivery{}
	}
	if d.References == nil {
		d.References = map[string]ReferenceRecord{}
	}
	if d.Peers == nil {
		d.Peers = map[string]Peer{}
	}
	if d.Operations == nil {
		d.Operations = map[string]Operation{}
	}
	if d.RetiredBindings == nil {
		d.RetiredBindings = map[string]Binding{}
	}
}
func cloneState(d State) State {
	b, _ := json.Marshal(d)
	var n State
	_ = json.Unmarshal(b, &n)
	return n
}
func (s *Store) Snapshot() State { s.mu.Lock(); defer s.mu.Unlock(); return cloneState(s.state) }

// A transaction is published to readers only after fsync + atomic replacement.
// All ledgers are bounded by refusing new admissions, never evicting a pending
// peer event or an uncertain agent submission to make room.
func (s *Store) Update(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := cloneState(s.state)
	if err := fn(&n); err != nil {
		return err
	}
	if len(n.Events) > maxRecords || len(n.Bindings) > maxRecords || len(n.References) > maxRecords || len(n.Operations) > maxRecords || len(n.Deliveries) > maxRecords || len(n.Peers) > maxPeers || len(n.ProviderTombstones) > maxRecords || len(n.Providers) > maxRecords || len(n.RetiredBindings) > maxRecords {
		return fault("resource_exhausted", "durable ledger limit reached")
	}
	b, err := json.Marshal(n)
	if err != nil {
		return err
	}
	if len(b) > 64<<20 {
		return fault("resource_exhausted", "durable state size limit reached")
	}
	f, err := os.CreateTemp(s.dir, ".state-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = privateStatePath(name, false); err != nil {
		return err
	}
	if err = replaceStateFile(name, filepath.Join(s.dir, "state.json")); err != nil {
		return err
	}
	s.state = n
	if runtime.GOOS != "windows" {
		d, e := os.Open(s.dir)
		if e != nil {
			return e
		}
		e = d.Sync()
		_ = d.Close()
		if e != nil {
			return e
		}
	}
	return nil
}
func (s *Store) Close() error { return s.lock.Unlock() }
