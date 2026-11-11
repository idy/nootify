package service

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestManagedOutputAppendsPrivateLogsAndRefusesRedirectedFiles(t *testing.T) {
	directory := t.TempDir()
	options := Options{StateDir: directory}
	for _, text := range []string{"first\n", "second\n"} {
		out, errout, err := ManagedOutput(options)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(out, text)
		_, _ = io.WriteString(errout, text)
		out.Close()
		errout.Close()
	}
	for _, name := range []string{"stdout.log", "stderr.log"} {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil || string(data) != "first\nsecond\n" {
			t.Fatal(name, string(data), err)
		}
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
			t.Fatal("log is not private", info.Mode())
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	external := filepath.Join(t.TempDir(), "retained")
	if err := os.WriteFile(external, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(directory, "stderr.log")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(directory, "stderr.log")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ManagedOutput(options); err == nil {
		t.Fatal("redirected log accepted")
	}
	data, _ := os.ReadFile(external)
	if string(data) != "unchanged" {
		t.Fatal("modified redirected destination")
	}
}
func TestManagedEnvironmentCannotInheritProviderAccountsOrAlternateHelpers(t *testing.T) {
	environment := []string{"SystemRoot=C:\\Windows", "HOME=safe", "Path=safe", "lark_app_secret=private", "SLACK_TOKEN=private", "TS_AUTHKEY=private", "NOOTIFY_CORE_BIN=private", "GITHUB_TOKEN=private", "NODE_OPTIONS=private", "NOOTIFY_GITHUB_CLIENT_ID=private"}
	clean := managedEnvironment(environment)
	if !slices.Equal(clean, environment[:3]) {
		t.Fatal("managed environment leaked ambient account configuration", clean)
	}
}
func TestEmbeddedTaskCommandFitsWindowsLimitWithoutLosingUnicode(t *testing.T) {
	source, err := os.ReadFile("task_windows.ps1")
	if err != nil {
		t.Fatal(err)
	}
	script := string(source) + "\n# Preserve Unicode paths: C:\\用户\\Nootify\n"
	encoded, err := powerShellCommand(script)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded)+1024 >= 32767 {
		t.Fatalf("Windows command line exceeds limit: %d", len(encoded))
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[2*i:])
	}
	bootstrap := string(utf16.Decode(units))
	_, tail, ok := strings.Cut(bootstrap, "FromBase64String('")
	if !ok {
		t.Fatal("missing in-memory payload")
	}
	payload, _, ok := strings.Cut(tail, "')")
	if !ok {
		t.Fatal("invalid in-memory payload")
	}
	compressed, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	restored, err := io.ReadAll(reader)
	if err != nil || string(restored) != script {
		t.Fatal("embedded controls changed during Windows argv encoding", err)
	}
}
