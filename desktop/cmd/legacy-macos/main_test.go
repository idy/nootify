//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestLegacyCommandOnlyDispatchesSameBundleEntries(t *testing.T) {
	contents := filepath.Join(t.TempDir(), "path with spaces", "Nootify.app", "Contents")
	cli := filepath.Join(contents, "Resources", "service", "dist", "src", "cli.js")
	server := filepath.Join(filepath.Dir(cli), "server.js")
	node := filepath.Join(contents, "MacOS", "node")
	retired := filepath.Join(contents, "MacOS", "nootify-core")
	foreign := filepath.Join(t.TempDir(), "cli.js")
	for _, file := range []string{cli, server, node, retired, foreign} {
		if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	contents, _ = filepath.EvalSymlinks(contents)
	for _, tt := range []struct {
		name string
		exe  string
		args []string
		want []string
	}{
		{"service recovery", node, []string{cli, "service-start", "--service-drain", `{"pid":123,"started":"old identity"}`}, []string{"service-start", "--preserve-legacy-launchd", "--service-drain", `{"pid":123,"started":"old identity"}`}},
		{"ordinary CLI", node, []string{cli, "thread-open", "--session-name", "a b"}, []string{"thread-open", "--session-name", "a b"}},
		{"daemon", node, []string{server, "--state-dir", "/state with spaces", "--port", "9417"}, []string{"serve", "--state-dir", "/state with spaces", "--port", "9417"}},
		{"foreign script", node, []string{foreign, "service-start"}, nil},
		{"missing entry", node, nil, nil},
		{"missing command", node, []string{cli}, nil},
		{"empty command", node, []string{cli, ""}, nil},
		{"GUI flags", node, []string{cli, "--smoke-test"}, nil},
		{"retired helper", retired, []string{cli, "service-start"}, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			target, args, err := legacyCommand(tt.exe, tt.args)
			if tt.want == nil {
				if err == nil {
					t.Fatal("accepted unsupported legacy invocation")
				}
				return
			}
			if err != nil || target != filepath.Join(contents, "MacOS", "Nootify") || !slices.Equal(args, tt.want) {
				t.Fatalf("target=%q args=%q error=%v", target, args, err)
			}
		})
	}
}
