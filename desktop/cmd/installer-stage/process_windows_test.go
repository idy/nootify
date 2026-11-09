package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerChildDirectoryProbe(t *testing.T) {
	for _, argument := range os.Args {
		if argument == "nootify-installer-cwd-probe" {
			directory, err := os.Getwd()
			if err != nil {
				os.Exit(26)
			}
			fmt.Print(directory)
			os.Exit(0)
		}
	}
}

func TestInstallerCommandsDoNotInheritPluginDirectoryOrEnvironment(t *testing.T) {
	plugins := diagnosticDirectory(t)
	put(t, filepath.Join(plugins, "System.dll"), "synthetic native plugin collision")
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		t.Fatal("missing Windows system root")
	}
	expected := filepath.Join(systemRoot, "System32")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(plugins)
	// The safe directory comes from the Windows API, not inherited variables.
	t.Setenv("SystemRoot", plugins)
	t.Setenv("WINDIR", plugins)
	output, err := runHidden(nil, "status", executable, "-test.run=^TestInstallerChildDirectoryProbe$", "--", "nootify-installer-cwd-probe")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(filepath.Clean(string(output)), filepath.Clean(expected)) {
		t.Fatalf("child inherited an unsafe directory: %q; expected %q", output, expected)
	}
}

func TestLegacyCompilerWorksThroughInstallerLauncherBesideNativeSystemDLL(t *testing.T) {
	plugins := diagnosticDirectory(t)
	systemRoot := os.Getenv("SystemRoot")
	native, err := os.ReadFile(filepath.Join(systemRoot, "System32", "kernel32.dll"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plugins, "System.dll"), native, 0600); err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(plugins, "legacy.cs"), "public static class LegacyInstallerCompilerProbe { public static int Result() { return new System.ComponentModel.Win32Exception(23).NativeErrorCode; } }")
	// This is intentionally the old import expression: launcher compatibility
	// must not depend on replacing an already-published installed service script.
	put(t, filepath.Join(plugins, "probe.ps1"), "$ErrorActionPreference='Stop'; Add-Type -LiteralPath (Join-Path $PSScriptRoot 'legacy.cs'); [Console]::Out.Write([LegacyInstallerCompilerProbe]::Result())")
	t.Chdir(plugins)
	powerShell := filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	output, err := runHidden(nil, "stop", powerShell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(plugins, "probe.ps1"))
	if err != nil || string(output) != "23" {
		t.Fatalf("legacy compiler failed under the installer launcher: %q, %v", output, err)
	}
}
