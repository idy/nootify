package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
)

type State struct {
	Version            int                        `json:"version"`
	NodeID             string                     `json:"node_id"`
	NodePrivateKey     string                     `json:"node_private_key"`
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
	FeishuCursors      map[string]int64           `json:"feishu_history_cursors,omitempty"`
	// A non-nil, possibly empty map marks the one-time pre-compaction upgrade.
	// These compact receipts authorize legacy relay frames without their own proof.
	LegacyActivityProofs map[string]string `json:"legacy_activity_proofs"`
	Retention            LedgerRetention   `json:"retention,omitempty"`
}
type Store struct {
	mu                sync.Mutex
	state             State
	dir               string
	lock              *flock.Flock
	clock             func() time.Time
	syncDirectory     func(string) error
	durabilityPending bool
	undispatched      map[string]func(*State) error
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
	s := &Store{dir: dir, lock: l, clock: time.Now, syncDirectory: syncStateDirectory}
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
	if err = s.Update(ensureNodeIdentity); err != nil {
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
	if d.FeishuCursors == nil {
		d.FeishuCursors = map[string]int64{}
	}
	d.Retention.init()
}
func cloneState(d State) State {
	b, _ := json.Marshal(d)
	var n State
	_ = json.Unmarshal(b, &n)
	// Empty optional maps disappear in JSON; transaction callbacks may write
	// their first cursor before any resource has populated the map.
	if n.FeishuCursors == nil {
		n.FeishuCursors = map[string]int64{}
	}
	return n
}
func (s *Store) Snapshot() State { s.mu.Lock(); defer s.mu.Unlock(); return cloneState(s.state) }

// DurableSnapshot is required before publishing peer events. A downstream may
// retain a queued callback longer than completed history at this node; its
// return route must therefore originate in a confirmed durable pending hold.
func (s *Store) DurableSnapshot() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.flushUndispatchedLocked(); err != nil && !stateCommitted(err) {
		return State{}, err
	}
	if s.durabilityPending {
		if err := s.syncDirectory(s.dir); err != nil {
			return State{}, &committedStateError{cause: err}
		}
		s.durabilityPending = false
	}
	return cloneState(s.state), nil
}

// Update commits at atomic replacement, after syncing the temporary file. Only
// a nil error confirms the subsequent directory durability barrier as well.
// A committedStateError requires callers to reconcile live effects to the new
// state while preserving the durability warning; other errors publish nothing.
// Completed ledgers age out before admission. Protected/within-horizon records
// are never evicted to make room: their limits still reject new admissions.
func (s *Store) Update(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.flushUndispatchedLocked(); err != nil {
		// This transaction's callback has not run. Do not let a committed
		// repair warning falsely report that its caller's mutation committed.
		return undispatchedFlushError(err)
	}
	return s.updateLocked(fn)
}

func (s *Store) updateLocked(fn func(*State) error) error {
	n := cloneState(s.state)
	// Migrate source evidence before either retention sweep can remove it.
	if err := backfillLegacyActivityProofs(&n); err != nil {
		return err
	}
	at := s.clock().UnixNano()
	n.Retention.at = at
	refreshRetention(&n, s.state, at)
	compactLedgers(&n, at)
	if err := fn(&n); err != nil {
		return err
	}
	refreshRetention(&n, s.state, at)
	compactLedgers(&n, at)
	n.Retention.at = 0
	if len(n.Events) > maxRecords || len(n.Bindings) > maxRecords || len(n.References) > maxRecords || len(n.Operations) > maxRecords || len(n.Deliveries) > maxRecords || len(n.Peers) > maxPeers || len(n.ProviderTombstones) > maxRecords || len(n.Providers) > maxRecords || len(n.RetiredBindings) > maxRecords || len(n.FeishuCursors) > maxRecords || len(n.LegacyActivityProofs) > 2*maxRecords {
		return fault("resource_exhausted", "durable ledger limit reached; pending work and retention horizons are preserved")
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
	s.durabilityPending = true
	if err = s.syncDirectory(s.dir); err != nil {
		return &committedStateError{cause: err}
	}
	s.durabilityPending = false
	return nil
}

// RepairUndispatched records proof owned by the current process that a side
// effect was never invoked. A failed repair stays queued until a later write,
// admission, durability retry, or orderly close can persist it. Callbacks only
// repair their exact pending record; they must not invoke providers or Store.
// An unwriteable filesystem plus a forced crash remains conservatively unknown.
func (s *Store) RepairUndispatched(key string, fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.undispatched == nil {
		s.undispatched = map[string]func(*State) error{}
	}
	if _, exists := s.undispatched[key]; !exists && len(s.undispatched) >= 2*maxRecords {
		return fault("resource_exhausted", "too many undispatched state repairs")
	}
	s.undispatched[key] = fn
	return s.flushUndispatchedLocked()
}

func (s *Store) FlushUndispatched() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.flushUndispatchedLocked()
}

func (s *Store) flushUndispatchedLocked() error {
	if len(s.undispatched) == 0 {
		return nil
	}
	keys := make([]string, 0, len(s.undispatched))
	for key := range s.undispatched {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	err := s.updateLocked(func(d *State) error {
		for _, key := range keys {
			if err := s.undispatched[key](d); err != nil {
				return err
			}
		}
		return nil
	})
	if stateCommitted(err) {
		// A post-rename warning still published the repair. Sync tracks its
		// remaining durability barrier; never reapply it over a later send.
		for _, key := range keys {
			delete(s.undispatched, key)
		}
	}
	return err
}

// Sync retries queued no-submission proofs and the current durability barrier,
// without issuing a provider call or changing a business cursor.
func (s *Store) Sync() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.flushUndispatchedLocked(); err != nil && !stateCommitted(err) {
		return err
	}
	if err := s.syncDirectory(s.dir); err != nil {
		s.durabilityPending = true
		return &committedStateError{cause: err}
	}
	s.durabilityPending = false
	return nil
}

func (s *Store) Close() error {
	err := s.FlushUndispatched()
	return errors.Join(err, s.lock.Unlock())
}
