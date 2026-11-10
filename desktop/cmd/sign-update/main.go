// sign-update produces the detached signatures consumed by installed Tauri and
// Go Nootify clients. Private keys are supplied explicitly by the invocation.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/idy/nootify/desktop/internal/updater"
)

func main() {
	if err := run(os.Args[1:], os.LookupEnv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "sign-update:", err)
		os.Exit(1)
	}
}

func run(args []string, lookup func(string) (string, bool), out io.Writer) error {
	flags := flag.NewFlagSet("sign-update", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	file := flags.String("file", "", "artifact to sign")
	version := flags.String("version", "", "release version (defaults to repository package.json when present)")
	if err := flags.Parse(args); err != nil || *file == "" || flags.NArg() != 0 {
		return errors.New("use sign-update --file <artifact> [--version <version>]")
	}
	key, _ := lookup("NOOTIFY_SIGNING_PRIVATE_KEY")
	if key == "" {
		key, _ = lookup("TAURI_SIGNING_PRIVATE_KEY")
	}
	if key == "" {
		return errors.New("set NOOTIFY_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY to a private key or private key file")
	}
	password, ok := lookup("NOOTIFY_SIGNING_PRIVATE_KEY_PASSWORD")
	if !ok {
		password, _ = lookup("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
	}
	var keyText []byte
	// As with the former Tauri signer, the value can be inline text/base64 or a
	// private file path. Do not print a file-open error: it can contain key input.
	if strings.HasPrefix(strings.TrimSpace(key), "untrusted comment:") || !looksLikeFile(key) {
		keyText = []byte(key)
	} else {
		f, err := os.Open(key)
		if err != nil {
			return errors.New("cannot read signing private key file")
		}
		defer f.Close()
		keyText, err = io.ReadAll(io.LimitReader(f, 16385))
		if err != nil || len(keyText) > 16384 {
			return errors.New("invalid signing private key file")
		}
	}
	if *version == "" {
		*version = repositoryVersion()
	}
	if err := updater.SignArtifact(context.Background(), *file, keyText, password, *version); err != nil {
		return err
	}
	_, err := fmt.Fprintln(out, *file+".sig")
	return err
}

func looksLikeFile(value string) bool {
	// Base64 contains '/', so check for an actual file first. Paths that do not
	// exist still fail closed in the key decoder with a secret-free error.
	info, err := os.Stat(value)
	return err == nil && info.Mode().IsRegular()
}

func repositoryVersion() string {
	for _, path := range []string{"package.json", "../package.json"} {
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		var metadata struct {
			Version string `json:"version"`
		}
		err = json.NewDecoder(io.LimitReader(file, 1<<20)).Decode(&metadata)
		file.Close()
		if err == nil {
			return metadata.Version
		}
	}
	return ""
}
