package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

const transactionName = ".nootify-installer"

// Only these package-owned roots can ever be exchanged or removed. Private
// state and other files in the installation directory are never transaction data.
var payloadRoots = []string{"Nootify.exe", "node.exe", "nootify-core.exe", "nootify-tsnet.exe", "service", "licenses", "uninstall.exe"}

type journal struct {
	Version    int      `json:"version"`
	Target     string   `json:"target"`
	Phase      string   `json:"phase"`
	Previous   []string `json:"previous"`
	Running    bool     `json:"running"`
	Enabled    *bool    `json:"enabled,omitempty"`
	FreshToken string   `json:"fresh_token,omitempty"`
}

type serviceState struct{ Running, Enabled bool }
type serviceControl interface {
	snapshot() (serviceState, error)
	stop() error
	start() error
	enable(bool) error
}

type transaction struct {
	target      string
	service     serviceControl
	diagnostics *diagnostics
	freshToken  string
	// Tests inject errors at actual filesystem and journal boundaries; production
	// has no environment variable or command-line fault injection switch.
	checkpoint func(string) error
}

func (t transaction) dir(parts ...string) string {
	return filepath.Join(append([]string{t.target, transactionName}, parts...)...)
}

func regularTree(path string) error {
	return filepath.WalkDir(path, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return fmt.Errorf("refusing redirected or special entry: %s", path)
		}
		return nil
	})
}

func plainAncestors(path string) error {
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err == nil {
			if !info.IsDir() || info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				return fmt.Errorf("refusing redirected installation path: %s", current)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if filepath.Dir(current) == current {
			return nil
		}
	}
}

func exists(path string) bool { _, err := os.Lstat(path); return err == nil }
func contains(values []string, value string) bool {
	for _, entry := range values {
		if entry == value {
			return true
		}
	}
	return false
}

func (t transaction) check(name string) error {
	if t.checkpoint != nil {
		return t.checkpoint(name)
	}
	return nil
}

func (t transaction) write(j journal) (result error) {
	t.diagnostics.begin("write-journal", "")
	defer func() { t.diagnostics.end("write-journal", "", result) }()
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(t.dir("journal.next"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = t.check("journal-next-open")
	if err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = t.check("journal-next-write")
	}
	if err == nil {
		err = file.Sync()
	}
	if err == nil {
		err = t.check("journal-next-sync")
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// RenameFile uses replace-existing + write-through on Windows.
	return renameJournal(t.dir("journal.next"), t.dir("journal.json"))
}

func (t transaction) read() (j journal, result error) {
	t.diagnostics.begin("read-journal", "")
	defer func() { t.diagnostics.end("read-journal", "", result) }()
	if err := plainAncestors(t.target); err != nil {
		return j, err
	}
	if err := regularTree(t.dir()); err != nil {
		return j, err
	}
	data, err := os.ReadFile(t.dir("journal.json"))
	if err != nil {
		return j, err
	}
	if len(data) > 4096 {
		return j, errors.New("invalid installer journal size")
	}
	if err = json.Unmarshal(data, &j); err != nil {
		return j, err
	}
	if j.Version != 1 || !strings.EqualFold(j.Target, t.target) || !contains([]string{"staging", "exchanging", "starting", "ready", "rolling-back", "restored", "committed", "quarantining", "removing"}, j.Phase) {
		return j, errors.New("refusing an unrecognized installer journal")
	}
	seen := map[string]bool{}
	for _, root := range j.Previous {
		if !contains(payloadRoots, root) || seen[root] {
			return j, errors.New("invalid installer journal payload roots")
		}
		seen[root] = true
	}
	if j.Phase == "staging" && (j.Running || len(j.Previous) != 0) {
		return j, errors.New("invalid staging journal")
	}
	if j.Phase == "quarantining" || j.Phase == "removing" {
		if j.FreshToken != "" || j.Running || j.Enabled != nil || contains(j.Previous, "uninstall.exe") {
			return j, errors.New("invalid uninstall removal journal")
		}
	}
	if j.FreshToken != "" {
		if t.freshToken == "" || j.FreshToken != t.freshToken || len(j.Previous) != 0 || j.Running || j.Enabled != nil && *j.Enabled {
			return j, errors.New("invalid fresh-install transaction ownership")
		}
	} else if t.freshToken != "" {
		return j, errors.New("fresh-install receipt does not match this journal")
	}
	return j, nil
}

func (t transaction) cleanup() (result error) {
	t.diagnostics.begin("cleanup", "")
	defer func() { t.diagnostics.end("cleanup", "", result) }()
	if err := regularTree(t.dir()); err != nil {
		return err
	}
	entries, err := os.ReadDir(t.dir())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !contains([]string{"new", "old", "discard", "journal.json", "journal.next"}, entry.Name()) {
			return errors.New("unrecognized installer transaction entry")
		}
	}
	// Keep the durable journal until every payload directory has been removed.
	// Interrupted cleanup can therefore be resumed without guessing ownership.
	for _, name := range []string{"new", "old", "discard"} {
		if err := os.RemoveAll(t.dir(name)); err != nil {
			return err
		}
	}
	if err := os.Remove(t.dir("journal.next")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(t.dir("journal.json")); err != nil {
		return err
	}
	return os.Remove(t.dir())
}

func (t transaction) prepare() (result error) {
	t.diagnostics.begin("prepare", "")
	defer func() { t.diagnostics.end("prepare", "", result) }()
	if err := plainAncestors(t.target); err != nil {
		return err
	}
	if exists(t.dir()) {
		if err := t.recover(); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(t.target, 0700); err != nil {
		return err
	}
	if err := os.Mkdir(t.dir(), 0700); err != nil {
		return err
	}
	if err := t.write(journal{Version: 1, Target: t.target, Phase: "staging", FreshToken: t.freshToken}); err != nil {
		return err
	}
	for _, name := range []string{"new", "old", "discard"} {
		if err := os.Mkdir(t.dir(name), 0700); err != nil {
			return err
		}
	}
	return nil
}

func (t transaction) validate(manifestPath string) (result error) {
	t.diagnostics.begin("validate", "")
	defer func() { t.diagnostics.end("validate", "", result) }()
	if err := regularTree(t.dir("new")); err != nil {
		return err
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	var expected map[string]string
	if err := json.Unmarshal(data, &expected); err != nil {
		return err
	}
	if len(expected) == 0 {
		return errors.New("empty installer manifest")
	}
	actual := map[string]string{}
	err = filepath.WalkDir(t.dir("new"), func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		relative, err := filepath.Rel(t.dir("new"), path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		if !contains(payloadRoots, strings.Split(name, "/")[0]) {
			return fmt.Errorf("unexpected staged payload: %s", name)
		}
		if name == "uninstall.exe" {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Size() == 0 {
				return errors.New("empty staged uninstaller")
			}
			return nil // WriteUninstaller is generated by the running NSIS package.
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		digest := sha256.New()
		_, err = io.Copy(digest, file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		actual[name] = hex.EncodeToString(digest.Sum(nil))
		return nil
	})
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, expected) {
		return errors.New("staged payload does not match the installer SHA-256 manifest")
	}
	for _, path := range []string{"Nootify.exe", "licenses/third-party-notices.txt", "uninstall.exe"} {
		info, err := os.Lstat(filepath.Join(t.dir("new"), filepath.FromSlash(path)))
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return fmt.Errorf("invalid required staged payload: %s", path)
		}
	}
	return nil
}

func (t transaction) apply(manifestPath string) (result error) {
	t.diagnostics.begin("apply", "")
	defer func() { t.diagnostics.end("apply", "", result) }()
	j, err := t.read()
	if err != nil {
		return err
	}
	if j.Phase != "staging" {
		return errors.New("installer transaction is not staged")
	}
	if err := t.validate(manifestPath); err != nil {
		return err
	}
	for _, root := range payloadRoots {
		path := filepath.Join(t.target, root)
		if exists(path) {
			if err := t.observe("old-tree", root, func() error { return regularTree(path) }); err != nil {
				return err
			}
			j.Previous = append(j.Previous, root)
		}
	}
	if t.freshToken != "" && len(j.Previous) != 0 {
		return errors.New("fresh installation contains unowned payload roots")
	}
	if t.service != nil {
		t.diagnostics.begin("status", "")
		var state serviceState
		state, err = t.service.snapshot()
		j.Running, j.Enabled = state.Running, &state.Enabled
		t.diagnostics.end("status", "", err)
		if err != nil {
			return err
		}
	}
	j.Phase = "exchanging"
	if err := t.write(j); err != nil {
		return err
	}
	defer func() {
		if result != nil {
			// Persist the original failure before rollback removes its evidence.
			t.diagnostics.end("apply", "", result)
			if err := t.recover(); err != nil {
				result = fmt.Errorf("%w; rollback needs retry: %v (previous payload retained in %s)", result, err, t.dir("old"))
			}
		}
	}()
	if err := t.check("before-stop"); err != nil {
		return err
	}
	// Even a stopped task must pass the CLI's owned-job drain checks: Scheduler
	// absence alone cannot prove there are no surviving descendant processes.
	// Only the previously running state authorizes a subsequent Start.
	if t.service != nil {
		if err := t.observe("stop", "", t.service.stop); err != nil {
			return err
		}
	}
	if err := t.check("after-stop"); err != nil {
		return err
	}
	for _, root := range payloadRoots {
		if contains(j.Previous, root) {
			if err := t.observe("backup", root, func() error { return renamePayload(filepath.Join(t.target, root), t.dir("old", root)) }); err != nil {
				return err
			}
			if err := t.check("backup:" + root); err != nil {
				return err
			}
		}
		if !exists(t.dir("new", root)) {
			continue
		} // Legacy roots are cleanup-only in current payloads.
		if err := t.observe("install", root, func() error { return renamePayload(t.dir("new", root), filepath.Join(t.target, root)) }); err != nil {
			return err
		}
		if err := t.check("install:" + root); err != nil {
			return err
		}
	}
	if j.Running {
		j.Phase = "starting"
		if err := t.write(j); err != nil {
			return err
		}
		if err := t.observe("start", "", t.service.start); err != nil {
			return err
		}
	}
	if j.Enabled != nil && t.service != nil {
		if err := t.observe("enable", "", func() error { return t.service.enable(*j.Enabled) }); err != nil {
			return err
		}
	}
	j.Phase = "ready"
	if err := t.write(j); err != nil {
		return err
	}
	return t.check("ready")
}

func (t transaction) recover() (result error) {
	t.diagnostics.begin("recover", "")
	defer func() { t.diagnostics.end("recover", "", result) }()
	if !exists(t.dir()) {
		return nil
	}
	if err := plainAncestors(t.target); err != nil {
		return err
	}
	if err := regularTree(t.dir()); err != nil {
		return err
	}
	entries, err := os.ReadDir(t.dir())
	if err != nil {
		return err
	}
	// A crash just before initial journal creation or just after final removal
	// can leave only the empty transaction directory. Nonrecursive removal is safe.
	if len(entries) == 0 {
		return os.Remove(t.dir())
	}
	// Before the first journal publication no root has moved and staging has
	// not begun. Only the lone regular next-file is disposable; extra entries
	// or a missing published journal after later work remain an error.
	if len(entries) == 1 && entries[0].Name() == "journal.next" {
		info, err := entries[0].Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > 4096 {
			return errors.New("invalid initial installer journal")
		}
		if err := os.Remove(t.dir("journal.next")); err != nil {
			return err
		}
		return os.Remove(t.dir())
	}
	j, err := t.read()
	if err != nil {
		return err
	}
	if j.Phase == "quarantining" {
		return t.restoreQuarantine(j)
	}
	if j.Phase == "removing" {
		// All roots must have moved before irreversible removal was authorized.
		// Do not skip service ownership checks for a newly resurrected payload.
		for _, root := range payloadRoots {
			if root != "uninstall.exe" && exists(filepath.Join(t.target, root)) {
				return errors.New("installed payload appeared during pending uninstall")
			}
		}
		return nil
	} // Only a retrying uninstaller may complete irreversible removal.
	if j.Phase == "committed" || j.Phase == "staging" {
		return t.cleanup()
	}
	// The new service may already have started before interruption. Stop its
	// validated owned task before moving anything back; errors retain all copies.
	if j.Running && (j.Phase == "starting" || j.Phase == "ready") {
		if err := t.observe("stop", "", t.service.stop); err != nil {
			return err
		}
	}
	if j.Phase != "restored" {
		// Once a reverse exchange begins, its CLI may temporarily be absent.
		// Persist that the new service was stopped before any reverse rename so
		// interrupted rollback never tries invoking a half-restored CLI.
		j.Phase = "rolling-back"
		if err := t.write(j); err != nil {
			return err
		}
		for _, root := range payloadRoots {
			installed := filepath.Join(t.target, root)
			old := t.dir("old", root)
			// The filesystem is the journal for each individual rename. In particular,
			// a crash between moving the old and new roots cannot lose that old root.
			if exists(old) || !contains(j.Previous, root) && !exists(t.dir("new", root)) {
				if exists(installed) {
					if err := t.observe("old-tree", root, func() error { return regularTree(installed) }); err != nil {
						return err
					}
					if err := t.observe("discard", root, func() error { return renamePayload(installed, t.dir("discard", root)) }); err != nil {
						return err
					}
					if err := t.check("discard:" + root); err != nil {
						return err
					}
				}
				if exists(old) {
					if err := t.observe("restore", root, func() error { return renamePayload(old, installed) }); err != nil {
						return err
					}
					if err := t.check("restore:" + root); err != nil {
						return err
					}
				}
			}
		}
		// A retry after a failed Start must not mistake restored old roots for
		// the newly installed payload and remove them.
		j.Phase = "restored"
		if err := t.write(j); err != nil {
			return err
		}
	}
	if j.Running {
		if t.service == nil {
			return errors.New("missing service control for rollback")
		}
		if err := t.observe("start", "", t.service.start); err != nil {
			return err
		}
	}
	if j.Enabled != nil && t.service != nil {
		if err := t.observe("enable", "", func() error { return t.service.enable(*j.Enabled) }); err != nil {
			return err
		}
	}
	return t.cleanup()
}

func (t transaction) finish() (result error) {
	t.diagnostics.begin("finish", "")
	defer func() { t.diagnostics.end("finish", "", result) }()
	j, err := t.read()
	if err != nil {
		return err
	}
	if j.Phase == "committed" {
		return t.cleanup()
	}
	if j.Phase != "ready" {
		return errors.New("installer payload is not ready to commit")
	}
	j.Phase = "committed"
	if err := t.write(j); err != nil {
		return err
	}
	// The commit is durable. Cleanup failure is harmless and the next prepare
	// retries it; never roll back a package after its registration was committed.
	if err := t.cleanup(); err != nil {
		fmt.Fprintln(os.Stderr, "Installer backup cleanup will be retried:", err)
	}
	return nil
}
