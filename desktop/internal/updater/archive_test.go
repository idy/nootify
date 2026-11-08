package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type tarEntry struct {
	name, body, link string
	kind             byte
	mode             int64
}

func bundleEntries() []tarEntry {
	entries := []tarEntry{}
	for _, name := range []string{"Nootify", "node", "nootify-core", "nootify-tsnet"} {
		entries = append(entries, tarEntry{name: "Nootify.app/Contents/MacOS/" + name, body: "new-" + name, mode: 0755})
	}
	for _, name := range []string{"cli.js", "server.js"} {
		entries = append(entries, tarEntry{name: "Nootify.app/Contents/Resources/service/dist/src/" + name, body: "// fake service", mode: 0644})
	}
	return append(entries, tarEntry{name: "Nootify.app/Contents/Info.plist", body: `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>dev.idy.nootify</string><key>CFBundleExecutable</key><string>Nootify</string></dict></plist>`, mode: 0644})
}
func tarBytes(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		kind := e.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		h := &tar.Header{Name: e.name, Mode: e.mode, Typeflag: kind, Linkname: e.link, Size: int64(len(e.body))}
		if kind != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Size > 0 {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func appArchive(t *testing.T, entries []tarEntry) string {
	return writeTemp(t, "Nootify.app.tar.gz", tarBytes(t, entries))
}

func TestArchiveValidation(t *testing.T) {
	valid := bundleEntries()
	tests := []struct {
		name   string
		extra  []tarEntry
		limits archiveLimits
	}{
		{name: "parent traversal", extra: []tarEntry{{name: "Nootify.app/../outside", body: "escape"}}},
		{name: "absolute", extra: []tarEntry{{name: "/tmp/outside", body: "escape"}}},
		{name: "backslash", extra: []tarEntry{{name: `Nootify.app/..\outside`, body: "escape"}}},
		{name: "other app", extra: []tarEntry{{name: "Other.app/file", body: "escape"}}},
		{name: "duplicate", extra: []tarEntry{valid[0]}},
		{name: "case collision", extra: []tarEntry{{name: "Nootify.app/Contents/MacOS/nootify", body: "duplicate"}}},
		{name: "absolute symlink", extra: []tarEntry{{name: "Nootify.app/link", kind: tar.TypeSymlink, link: "/tmp"}}},
		{name: "escaping symlink", extra: []tarEntry{{name: "Nootify.app/link", kind: tar.TypeSymlink, link: "../../outside"}}},
		{name: "dangling symlink", extra: []tarEntry{{name: "Nootify.app/link", kind: tar.TypeSymlink, link: "missing"}}},
		{name: "cyclic symlink", extra: []tarEntry{{name: "Nootify.app/a", kind: tar.TypeSymlink, link: "b"}, {name: "Nootify.app/b", kind: tar.TypeSymlink, link: "a"}}},
		{name: "hardlink", extra: []tarEntry{{name: "Nootify.app/hard", kind: tar.TypeLink, link: valid[0].name}}},
		{name: "fifo", extra: []tarEntry{{name: "Nootify.app/fifo", kind: tar.TypeFifo}}},
		{name: "setuid", extra: []tarEntry{{name: "Nootify.app/privileged", body: "x", mode: 04755}}},
		{name: "size limit", limits: archiveLimits{bytes: 8, entries: 100}},
		{name: "entry limit", limits: archiveLimits{bytes: maxExpanded, entries: 2}},
		{name: "symlink ancestor", extra: []tarEntry{{name: "Nootify.app/folder", kind: tar.TypeSymlink, link: "Contents"}, {name: "Nootify.app/folder/child", kind: tar.TypeSymlink, link: "MacOS"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entries := append(append([]tarEntry(nil), valid...), tt.extra...)
			limits := tt.limits
			if limits.entries == 0 {
				limits = defaultArchiveLimits
			}
			if err := extractApp(context.Background(), appArchive(t, entries), t.TempDir(), limits); err == nil {
				t.Fatal("accepted unsafe archive")
			}
		})
	}
	if runtime.GOOS == "windows" {
		return
	} // Execute permissions are validated on macOS/Unix.
	if err := extractApp(context.Background(), appArchive(t, valid), t.TempDir(), defaultArchiveLimits); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		entries := append(valid, tarEntry{name: "Nootify.app/Contents/Resources/cli-link", kind: tar.TypeSymlink, link: "service/dist/src/cli.js"})
		if err := extractApp(context.Background(), appArchive(t, entries), t.TempDir(), defaultArchiveLimits); err != nil {
			t.Fatal("safe internal symlink", err)
		}
	}
	for _, entries := range [][]tarEntry{valid[:len(valid)-1], {{name: "Nootify.app/Contents/MacOS/Nootify", body: "fake", mode: 0644}}} {
		if err := extractApp(context.Background(), appArchive(t, entries), t.TempDir(), defaultArchiveLimits); err == nil {
			t.Fatal("accepted incomplete bundle")
		}
	}
	badIdentity := append([]tarEntry(nil), valid...)
	badIdentity[len(valid)-1].body = strings.ReplaceAll(valid[len(valid)-1].body, "dev.idy.nootify", "other.app")
	if err := extractApp(context.Background(), appArchive(t, badIdentity), t.TempDir(), defaultArchiveLimits); err == nil {
		t.Fatal("accepted wrong app identity")
	}
}

func TestArchiveCorruptionAndCancellation(t *testing.T) {
	good := tarBytes(t, bundleEntries())
	badCRC := append([]byte(nil), good...)
	badCRC[len(badCRC)-8] ^= 0xff
	for _, data := range [][]byte{good[:len(good)-6], badCRC, append(append([]byte(nil), good...), good...), []byte("not gzip")} {
		if err := extractApp(context.Background(), writeTemp(t, "app.gz", data), t.TempDir(), defaultArchiveLimits); err == nil {
			t.Fatal("accepted corrupt archive")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := extractApp(ctx, appArchive(t, bundleEntries()), t.TempDir(), defaultArchiveLimits); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func testSwap(a, b string) error {
	temp := a + ".swap"
	if err := os.Rename(a, temp); err != nil {
		return err
	}
	if err := os.Rename(b, a); err != nil {
		_ = os.Rename(temp, a)
		return err
	}
	return os.Rename(temp, b)
}
func installedFakeApp(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Nootify.app")
	exe := filepath.Join(root, "Contents", "MacOS", "Nootify")
	if err := os.MkdirAll(filepath.Dir(exe), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, []byte("original"), 0755); err != nil {
		t.Fatal(err)
	}
	return exe
}

func TestMacReplacementAndRollback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("macOS bundle permission and symlink semantics")
	}
	for _, scenario := range []string{"success", "stop error", "swap error", "relaunch error", "rollback error"} {
		t.Run(scenario, func(t *testing.T) {
			exe := installedFakeApp(t)
			var calls []string
			m := New(Options{Executable: exe, BeforeInstall: func(context.Context) error {
				calls = append(calls, "before")
				old, _ := os.ReadFile(exe)
				if string(old) != "original" {
					t.Fatal("replaced before stop")
				}
				if scenario == "stop error" {
					return errors.New("stop failed")
				}
				return nil
			}, AfterInstall: func() error {
				calls = append(calls, "after")
				data, _ := os.ReadFile(exe)
				if string(data) != "new-Nootify" {
					t.Fatal("not replaced before relaunch")
				}
				if scenario == "relaunch error" || scenario == "rollback error" {
					return errors.New("relaunch failed")
				}
				return nil
			}})
			if runtime.GOOS != "darwin" {
				m.swap = testSwap
			}
			originalSwap := m.swap
			swaps := 0
			m.swap = func(a, b string) error {
				swaps++
				if scenario == "swap error" || scenario == "rollback error" && swaps == 2 {
					return errors.New("swap failed")
				}
				return originalSwap(a, b)
			}
			err := m.installMac(context.Background(), appArchive(t, bundleEntries()))
			if (err == nil) != (scenario == "success") {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(exe)
			expected := "original"
			if scenario == "success" || scenario == "rollback error" {
				expected = "new-Nootify"
			}
			if string(data) != expected {
				t.Fatalf("bundle %q, want %q", data, expected)
			}
			leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(exe))), "..", ".nootify-update-*"))
			if scenario == "rollback error" {
				if len(leftovers) != 1 {
					t.Fatal("lost recovery bundle", leftovers)
				}
				old, _ := os.ReadFile(filepath.Join(leftovers[0], "Nootify.app", "Contents", "MacOS", "Nootify"))
				if string(old) != "original" {
					t.Fatal("original was not retained")
				}
			} else if len(leftovers) != 0 {
				t.Fatal("temporary app left behind", leftovers)
			}
			if len(calls) == 0 || calls[0] != "before" {
				t.Fatal(calls)
			}
		})
	}
}

func TestInvalidArchiveDoesNotStopService(t *testing.T) {
	exe := installedFakeApp(t)
	before := false
	m := New(Options{Executable: exe, BeforeInstall: func(context.Context) error { before = true; return nil }})
	if err := m.installMac(context.Background(), appArchive(t, []tarEntry{{name: "../bad", body: "bad"}})); err == nil || before {
		t.Fatal("unsafe archive reached install hook", err)
	}
	if _, err := appRoot("Nootify"); err == nil {
		t.Fatal("accepted development executable")
	}
}
