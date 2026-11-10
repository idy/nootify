package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aead.dev/minisign"
)

func TestCLIKeySourcesAndCompatibility(t *testing.T) {
	public, private, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, _ := private.MarshalText()
	for _, source := range []string{"nootify inline", "tauri inline", "nootify file", "tauri file", "raw minisign", "nootify precedence"} {
		t.Run(source, func(t *testing.T) {
			dir := t.TempDir()
			artifact := filepath.Join(dir, "Nootify-setup.exe")
			data := []byte("synthetic signed artifact")
			if err := os.WriteFile(artifact, data, 0600); err != nil {
				t.Fatal(err)
			}
			keyValue := base64.StdEncoding.EncodeToString(key)
			if strings.Contains(source, "file") {
				keyValue = filepath.Join(dir, "synthetic.key")
				if err := os.WriteFile(keyValue, key, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if source == "raw minisign" {
				keyValue = string(key)
			}
			name := "NOOTIFY_SIGNING_PRIVATE_KEY"
			if strings.HasPrefix(source, "tauri") {
				name = "TAURI_SIGNING_PRIVATE_KEY"
			}
			env := map[string]string{name: keyValue}
			if source == "nootify precedence" {
				env["TAURI_SIGNING_PRIVATE_KEY"] = "invalid-compat-secret"
			}
			var output bytes.Buffer
			err := run([]string{"--file", artifact, "--version", "1.2.3"}, func(k string) (string, bool) { v, ok := env[k]; return v, ok }, &output)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := os.ReadFile(artifact + ".sig")
			if err != nil {
				t.Fatal(err)
			}
			signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
			if err != nil {
				t.Fatal(err)
			}
			if !minisign.Verify(public, data, signature) {
				t.Fatal("signature not compatible")
			}
			if output.String() != artifact+".sig\n" || strings.Contains(output.String(), keyValue) {
				t.Fatal("unexpected signer output")
			}
		})
	}
}

func TestCLIErrorsDoNotPrintSecrets(t *testing.T) {
	secret := "private-synthetic-secret-invalid-value"
	for _, args := range [][]string{{}, {"--file", "missing", "--password", "synthetic-password"}, {"--file", "missing"}} {
		var output bytes.Buffer
		err := run(args, func(name string) (string, bool) {
			if name == "TAURI_SIGNING_PRIVATE_KEY" {
				return secret, true
			}
			return "", false
		}, &output)
		if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "synthetic-password") || output.Len() != 0 {
			t.Fatal("unsafe CLI error", err)
		}
	}
}
