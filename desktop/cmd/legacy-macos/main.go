//go:build darwin

// The Node-era updater keeps using its cached node/cli.js paths after swapping
// bundles. This native launcher preserves that invocation contract, not Node.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func legacyCommand(executable string, args []string) (string, []string, error) {
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", nil, err
	}
	if filepath.Base(executable) != "node" || len(args) == 0 {
		return "", nil, errors.New("this legacy entry is retired; use the Nootify executable")
	}
	contents := filepath.Dir(filepath.Dir(executable))
	if filepath.Base(filepath.Dir(executable)) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(filepath.Dir(contents)) != ".app" {
		return "", nil, errors.New("legacy launcher requires an installed app bundle")
	}
	entry, err := filepath.EvalSymlinks(args[0])
	if err != nil {
		return "", nil, err
	}
	service := filepath.Join(contents, "Resources", "service", "dist", "src")
	var forwarded []string
	switch entry {
	case filepath.Join(service, "cli.js"):
		if len(args) < 2 || strings.HasPrefix(args[1], "-") || args[1] == "" {
			return "", nil, errors.New("the legacy CLI launcher requires a command")
		}
		forwarded = append([]string(nil), args[1:]...)
		if strings.HasPrefix(args[1], "service-") || args[1] == "launchd-install" {
			// The old supervisor may still restore its original bundle on failure.
			// Rewriting its plist here would prevent the old CLI from recovering it.
			forwarded = append([]string{args[1], "--preserve-legacy-launchd"}, args[2:]...)
		}
	case filepath.Join(service, "server.js"):
		forwarded = append([]string{"serve"}, args[1:]...)
	default:
		return "", nil, errors.New("legacy launcher only accepts this app's bundled CLI or server entry")
	}
	return filepath.Join(contents, "MacOS", "Nootify"), forwarded, nil
}

func main() {
	executable, err := os.Executable()
	if err == nil {
		var target string
		var args []string
		target, args, err = legacyCommand(executable, os.Args[1:])
		if err == nil {
			err = syscall.Exec(target, append([]string{target}, args...), os.Environ())
		}
	}
	fmt.Fprintln(os.Stderr, err)
	os.Exit(64)
}
