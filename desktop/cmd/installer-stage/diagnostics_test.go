package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func diagnosticDirectory(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func diagnosticRows(t *testing.T, directory string) ([]diagnosticRecord, []byte) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	var rows []diagnosticRecord
	var all []byte
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "helper-") || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, data...)
		decoder := json.NewDecoder(bytes.NewReader(data))
		for {
			var row diagnosticRecord
			if err := decoder.Decode(&row); err != nil {
				if errors.Is(err, io.EOF) {
					break
				}
				t.Fatal(err)
			}
			rows = append(rows, row)
		}
	}
	return rows, all
}

func TestDiagnosticsCreateNewAndNeverSerializePrivateText(t *testing.T) {
	directory := diagnosticDirectory(t)
	private := "synthetic-private-path-token-and-output"
	t.Setenv("INSTALLER_TEST_PRIVATE_VALUE", private)
	// An existing file is never reused as the report for another helper.
	sentinel := filepath.Join(directory, "unrelated-existing-file")
	put(t, sentinel, private)
	for range 2 {
		d := newDiagnostics(directory, private)
		if d == nil {
			t.Fatal("valid diagnostic directory was rejected")
		}
		d.begin("helper", "")
		d.end("backup", "node.exe", &os.PathError{Op: private, Path: private, Err: syscall.EACCES})
		d.end(private, private, errors.New(private))
		d.end("helper", "", nil)
		d.close()
	}
	rows, data := diagnosticRows(t, directory)
	if len(rows) != 8 {
		t.Fatalf("expected two complete reports, got %d rows", len(rows))
	}
	if bytes.Contains(data, []byte(private)) || bytes.Contains(data, []byte(directory)) {
		t.Fatal("diagnostics exposed private text")
	}
	if rows[1].Phase != "backup" || rows[1].Root != "node.exe" || rows[1].Category != "os-error" || rows[1].OSErrno != uint64(syscall.EACCES) {
		t.Fatal(rows[1])
	}
	if rows[2].Phase != "other" || rows[2].Root != "" || rows[2].Action != "other" {
		t.Fatal("diagnostic vocabularies were not constrained")
	}
	if rows[3].Outcome != "success" || rows[3].Phase != "helper" {
		t.Fatal("missing successful helper completion")
	}
	original, err := os.ReadFile(sentinel)
	if err != nil || string(original) != private {
		t.Fatal("pre-existing file was changed")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 3 {
		t.Fatal("reports were not created under distinct new filenames")
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "helper-") {
			info, err := entry.Info()
			if err != nil {
				t.Fatal(err)
			}
			if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
				t.Fatal("diagnostic report is readable outside its owner")
			}
		}
	}
}

func TestDiagnosticsRejectInvalidAndRedirectedDestinations(t *testing.T) {
	directory := diagnosticDirectory(t)
	file := filepath.Join(directory, "existing-file")
	put(t, file, "keep")
	for _, path := range []string{"", "relative-directory", filepath.Join(directory, "missing"), file} {
		if d := newDiagnostics(path, "apply"); d != nil {
			d.close()
			t.Fatal("accepted an invalid diagnostic destination")
		}
	}
	if exists(filepath.Join(directory, "missing")) {
		t.Fatal("diagnostics created a missing destination")
	}
	t.Run("symlink-directory-and-ancestor", func(t *testing.T) {
		outside := diagnosticDirectory(t)
		if err := os.Mkdir(filepath.Join(outside, "child"), 0700); err != nil {
			t.Fatal(err)
		}
		redirect := filepath.Join(directory, "redirect")
		if err := os.Symlink(outside, redirect); err != nil {
			t.Skip("symlink creation unavailable")
		}
		for _, path := range []string{redirect, filepath.Join(redirect, "child")} {
			if d := newDiagnostics(path, "apply"); d != nil {
				d.close()
				t.Fatal("accepted redirected diagnostic destination")
			}
		}
		entries, err := os.ReadDir(filepath.Join(outside, "child"))
		if err != nil || len(entries) != 0 {
			t.Fatal("diagnostics traversed a redirect")
		}
	})
}

func TestDiagnosticsStayConfinedIfDirectoryNameIsReplaced(t *testing.T) {
	directory := diagnosticDirectory(t)
	d := newDiagnostics(directory, "prepare")
	if d == nil {
		t.Fatal("missing diagnostic writer")
	}
	defer d.close()
	moved := directory + "-moved"
	if err := os.Rename(directory, moved); err != nil {
		t.Skip("platform does not allow moving an open report directory")
	}
	t.Cleanup(func() { _ = os.Rename(moved, directory) })
	outside := diagnosticDirectory(t)
	if err := os.Symlink(outside, directory); err != nil {
		t.Skip("symlink creation unavailable")
	}
	t.Cleanup(func() { _ = os.Remove(directory) })
	d.begin("prepare", "")
	d.end("prepare", "", nil)
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("an open diagnostic writer followed a replacement path")
	}
	rows, _ := diagnosticRows(t, moved)
	if len(rows) != 2 {
		t.Fatal("the report lost its original directory identity")
	}
}

func TestDiagnosticResponseCategoriesDoNotExposeOutput(t *testing.T) {
	directory := diagnosticDirectory(t)
	d := newDiagnostics(directory, "apply")
	if d == nil {
		t.Fatal("missing diagnostic writer")
	}
	d.invalidResponse("status", nil)
	d.invalidResponse("legacy-snapshot", []byte("{synthetic-private-output"))
	d.invalidResponse("status", []byte(`{"unrecognized":"synthetic-private-output"}`))
	d.close()
	rows, raw := diagnosticRows(t, directory)
	if len(rows) != 3 || rows[0].Category != "empty-response" || rows[1].Category != "malformed-json" || rows[2].Category != "invalid-response" {
		t.Fatal(rows)
	}
	if rows[0].Phase != "status" || rows[1].Phase != "legacy-snapshot" || bytes.Contains(raw, []byte("synthetic-private-output")) {
		t.Fatal("response source or privacy contract failed")
	}
	for _, row := range rows {
		if row.OutputBytes == nil || row.Kind != "response" || row.Outcome != "failure" {
			t.Fatal(row)
		}
	}
}

// This subprocess fixture runs only the current portable Go test binary. It
// never starts an installed service, a Windows component or a shell.
func TestDiagnosticChildProcess(t *testing.T) {
	for index, argument := range os.Args {
		if argument != "installer-diagnostic-child" || index+1 >= len(os.Args) {
			continue
		}
		if os.Getenv(diagnosticsVariable) != "" {
			os.Exit(25)
		}
		switch os.Args[index+1] {
		case "exit":
			fmt.Fprint(os.Stdout, "synthetic-private-child-output")
			fmt.Fprint(os.Stderr, "synthetic-private-child-error")
			os.Exit(23)
		case "success":
			_, _ = os.Stdout.Write([]byte("\xef\xbb\xbf{\"installed\":true}\n"))
			os.Exit(0)
		}
		os.Exit(24)
	}
}

func TestHiddenCommandDiagnosticsKeepActualExitAndTimeoutWithoutOutput(t *testing.T) {
	directory := diagnosticDirectory(t)
	d := newDiagnostics(directory, "apply")
	if d == nil {
		t.Fatal("missing diagnostic writer")
	}
	t.Setenv(diagnosticsVariable, directory)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"-test.run=^TestDiagnosticChildProcess$", "--", "installer-diagnostic-child"}
	if _, err := runHidden(d, "stop", executable, append(args, "exit")...); err == nil || err.Error() != "owned service command failed or timed out" {
		t.Fatal("child failure message changed")
	}
	data, err := runHidden(d, "status", executable, append(args, "success")...)
	if err != nil || string(data) != `{"installed":true}` {
		t.Fatal("successful child output parsing changed", err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := runHiddenContext(ctx, d, "legacy-snapshot", executable, append(args, "success")...); err == nil {
		t.Fatal("expired child context did not fail")
	}
	missing := filepath.Join(directory, "synthetic-private-missing-executable")
	// Windows LookPath can return exec.ErrNotFound without a numeric errno;
	// Unix typically retains ENOENT. Record only facts the platform supplies.
	lookupErr := exec.Command(missing).Run()
	if lookupErr == nil {
		t.Fatal("missing command unexpectedly exists")
	}
	var expectedErrno syscall.Errno
	_ = errors.As(lookupErr, &expectedErrno)
	if _, err := runHidden(d, "start", missing); err == nil {
		t.Fatal("missing command did not fail")
	}
	d.close()
	rows, raw := diagnosticRows(t, directory)
	if bytes.Contains(raw, []byte(directory)) || bytes.Contains(raw, []byte("synthetic-private")) || bytes.Contains(raw, []byte(executable)) {
		t.Fatal("child diagnostics exposed paths or output")
	}
	var exit, success, timeout, spawn bool
	for _, row := range rows {
		if row.Kind != "command" || row.Outcome == "begin" {
			continue
		}
		switch row.Phase {
		case "stop":
			exit = row.Category == "child-exit" && row.ExitCode != nil && *row.ExitCode == 23 && !row.TimedOut
		case "status":
			success = row.Outcome == "success" && row.ExitCode != nil && *row.ExitCode == 0 && row.OutputBytes != nil && *row.OutputBytes > 0 && row.UTF8BOM
		case "legacy-snapshot":
			timeout = row.Category == "timeout" && row.TimedOut
		case "start":
			spawn = row.Outcome == "failure" && row.Category == "child-start" && row.OSErrno == uint64(expectedErrno) && row.ExitCode == nil && !row.TimedOut
		}
	}
	if !exit || !success || !timeout || !spawn {
		t.Fatal("missing actual child process failure facts", rows)
	}
}

func TestDiagnosticsPreserveRollbackAndRecordFailureBeforeCleanup(t *testing.T) {
	for _, broken := range []bool{false, true} {
		t.Run(map[bool]string{false: "enabled", true: "write-failure"}[broken], func(t *testing.T) {
			tx, service, manifest, before := fixture(t, true)
			directory := diagnosticDirectory(t)
			d := newDiagnostics(directory, "apply")
			if d == nil {
				t.Fatal("missing diagnostic writer")
			}
			defer d.close()
			if broken {
				if err := d.file.Close(); err != nil {
					t.Fatal(err)
				}
			}
			tx.diagnostics = d
			original := &os.PathError{Op: "synthetic-private-operation", Path: "synthetic-private-path", Err: syscall.EACCES}
			tx.checkpoint = func(name string) error {
				if name == "install:node.exe" {
					return original
				}
				return nil
			}
			if err := tx.apply(manifest); err != original {
				t.Fatal("diagnostics changed the original installer error", err)
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) || !service.active || exists(tx.dir()) {
				t.Fatal("diagnostics changed payload rollback or service restoration")
			}
			if !reflect.DeepEqual(service.calls, []string{"status", "stop", "start"}) {
				t.Fatal("diagnostics changed service lifecycle", service.calls)
			}
			if broken {
				return
			}
			rows, raw := diagnosticRows(t, directory)
			failure, rollback, cleanup := -1, -1, -1
			for index, row := range rows {
				if row.Phase == "apply" && row.Outcome == "failure" && failure == -1 {
					failure = index
				}
				if row.Phase == "recover" && row.Outcome == "begin" {
					rollback = index
				}
				if row.Phase == "cleanup" && row.Outcome == "begin" {
					cleanup = index
				}
			}
			if failure < 0 || rollback <= failure || cleanup <= rollback {
				t.Fatal("original failure was not recorded before rollback/cleanup", rows)
			}
			if bytes.Contains(raw, []byte("synthetic-private")) || bytes.Contains(raw, []byte(tx.target)) {
				t.Fatal("rollback diagnostics exposed private paths/errors")
			}
		})
	}
}
