package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

const diagnosticsVariable = "NOOTIFY_INSTALLER_DIAGNOSTICS"

// Diagnostic strings are selected from fixed vocabularies. Error text, child
// output, arguments, paths and environment values never enter this schema.
type diagnosticRecord struct {
	Version     int    `json:"version"`
	Sequence    uint64 `json:"sequence"`
	Action      string `json:"action"`
	Phase       string `json:"phase"`
	Kind        string `json:"kind"`
	Outcome     string `json:"outcome"`
	Root        string `json:"root,omitempty"`
	Category    string `json:"category,omitempty"`
	ExitCode    *int   `json:"exit_code,omitempty"`
	TimedOut    bool   `json:"timed_out,omitempty"`
	OSErrno     uint64 `json:"os_errno,omitempty"`
	OutputBytes *int   `json:"output_bytes,omitempty"`
	UTF8BOM     bool   `json:"utf8_bom,omitempty"`
	UTF16BOM    bool   `json:"utf16_bom,omitempty"`
}

type diagnostics struct {
	mu       sync.Mutex
	file     *os.File
	action   string
	sequence uint64
}

func newDiagnostics(directory, action string) *diagnostics {
	if directory == "" || !filepath.IsAbs(directory) || plainAncestors(directory) != nil {
		return nil
	}
	before, err := os.Lstat(directory)
	if err != nil || !before.IsDir() || before.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return nil
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil
	}
	defer root.Close()
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(before, opened) {
		return nil
	}
	if !contains([]string{"prepare", "apply", "recover", "finish"}, action) {
		action = "other"
	}
	for range 8 {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil
		}
		name := "helper-" + hex.EncodeToString(random[:]) + ".jsonl"
		// Root has no CreateTemp method. A random name plus rooted O_EXCL has
		// the same create-new guarantee and cannot traverse a planted symlink.
		file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil
		}
		return &diagnostics{file: file, action: action}
	}
	return nil
}

func (d *diagnostics) close() {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.file != nil {
		_ = d.file.Close()
		d.file = nil
	}
}

func (d *diagnostics) record(phase, kind, outcome, root string, failure error, command *commandFailure) {
	if d == nil {
		return
	}
	if !contains([]string{"helper", "arguments", "lock", "prepare", "apply", "recover", "finish", "read-journal", "write-journal", "validate", "old-tree", "status", "legacy-snapshot", "stop", "backup", "install", "discard", "restore", "start", "cleanup"}, phase) {
		phase = "other"
	}
	if !contains(payloadRoots, root) {
		root = ""
	}
	if !contains([]string{"stage", "command", "response"}, kind) {
		kind = "stage"
	}
	if !contains([]string{"begin", "success", "failure"}, outcome) {
		outcome = "failure"
	}
	record := diagnosticRecord{Version: 1, Action: d.action, Phase: phase, Kind: kind, Outcome: outcome, Root: root}
	if failure != nil {
		record.Category = "failure"
		var errno syscall.Errno
		if errors.As(failure, &errno) {
			record.OSErrno = uint64(errno)
			record.Category = "os-error"
		}
		var child *commandFailure
		if errors.As(failure, &child) {
			command = child
		}
		var response *responseFailure
		if errors.As(failure, &response) {
			record.Category = response.category
			record.OutputBytes = &response.outputBytes
		}
	}
	if command != nil {
		record.ExitCode = command.exitCode
		record.OutputBytes = command.outputBytes
		record.UTF8BOM = command.utf8BOM
		record.UTF16BOM = command.utf16BOM
		record.TimedOut = command.timedOut
		record.OSErrno = command.osErrno
		if command.timedOut {
			record.Category = "timeout"
		} else if outcome == "failure" {
			if command.exitCode != nil {
				record.Category = "child-exit"
			} else {
				record.Category = "child-start"
			}
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.file == nil {
		return
	}
	d.sequence++
	record.Sequence = d.sequence
	if err := json.NewEncoder(d.file).Encode(record); err != nil {
		_ = d.file.Close()
		d.file = nil
		return
	}
	// An abrupt helper exit must leave the last completed stage visible. Failure
	// to persist optional diagnostics never changes an installer decision.
	if err := d.file.Sync(); err != nil {
		_ = d.file.Close()
		d.file = nil
	}
}

func (d *diagnostics) begin(phase, root string) { d.record(phase, "stage", "begin", root, nil, nil) }
func (d *diagnostics) end(phase, root string, err error) {
	outcome := "success"
	if err != nil {
		outcome = "failure"
	}
	d.record(phase, "stage", outcome, root, err, nil)
}

func (t transaction) observe(phase, root string, operation func() error) error {
	t.diagnostics.begin(phase, root)
	err := operation()
	t.diagnostics.end(phase, root, err)
	return err
}

// Carries only safe process facts. Keeping Error's existing fixed text avoids
// exposing executable paths through exec.ExitError or exec.Error formatting.
type commandFailure struct {
	exitCode    *int
	timedOut    bool
	osErrno     uint64
	outputBytes *int
	utf8BOM     bool
	utf16BOM    bool
}

func (*commandFailure) Error() string { return "owned service command failed or timed out" }

func commandOutput(data []byte) *commandFailure {
	count := len(data)
	return &commandFailure{outputBytes: &count, utf8BOM: bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}),
		utf16BOM: bytes.HasPrefix(data, []byte{0xff, 0xfe}) || bytes.HasPrefix(data, []byte{0xfe, 0xff})}
}

type responseFailure struct {
	category    string
	outputBytes int
}

func (*responseFailure) Error() string { return "invalid service response" }

func (d *diagnostics) invalidResponse(phase string, data []byte) {
	category := "invalid-response"
	if len(bytes.TrimSpace(data)) == 0 {
		category = "empty-response"
	} else if !json.Valid(data) {
		category = "malformed-json"
	}
	d.record(phase, "response", "failure", "", &responseFailure{category: category, outputBytes: len(data)}, nil)
}
