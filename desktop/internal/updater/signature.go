package updater

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"aead.dev/minisign"
	"golang.org/x/mod/semver"
)

const maxKeyText = 16 << 10

// Tauri stores base64 of the complete minisign text, including comments.
// Also accept native minisign text for local tooling and migration fixtures.
func minisignText(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > maxKeyText {
		return nil, errors.New("invalid minisign text length")
	}
	if strings.HasPrefix(value, "untrusted comment: ") {
		return []byte(value), nil
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || !strings.HasPrefix(string(decoded), "untrusted comment: ") {
		return nil, errors.New("invalid minisign encoding")
	}
	return []byte(strings.TrimSpace(string(decoded))), nil
}

func parsePublicKey(text string) (minisign.PublicKey, error) {
	var key minisign.PublicKey
	data, err := minisignText(text)
	if err != nil {
		return key, errors.New("invalid updater public key encoding")
	}
	if err = key.UnmarshalText(data); err != nil {
		return key, errors.New("invalid updater public key")
	}
	return key, nil
}
func parseSignature(text string) ([]byte, error) {
	data, err := minisignText(text)
	if err != nil {
		return nil, errors.New("invalid update signature encoding")
	}
	var sig minisign.Signature
	if err = sig.UnmarshalText(data); err != nil {
		return nil, errors.New("invalid update signature")
	}
	return data, nil
}

func verifyArtifact(ctx context.Context, path, publicKey, signature, version string) error {
	key, err := parsePublicKey(publicKey)
	if err != nil {
		return err
	}
	text, err := parseSignature(signature)
	if err != nil {
		return err
	}
	var sig minisign.Signature
	_ = sig.UnmarshalText(text)
	if sig.KeyID != key.ID() {
		return errors.New("update signature key does not match")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxArtifact {
		return errors.New("invalid update artifact size or type")
	}
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(file, maxArtifact+1)}
	valid := false
	if sig.Algorithm == minisign.HashEdDSA {
		hashed := minisign.NewReader(reader)
		n, err := io.Copy(io.Discard, hashed)
		if err != nil {
			return err
		}
		valid = n == info.Size() && hashed.Verify(key, text)
	} else {
		// Legacy Ed signatures sign the original message. The feed size ceiling also
		// bounds this compatibility path; all new artifacts use streaming ED signatures.
		data, err := io.ReadAll(reader)
		if err != nil {
			return err
		}
		valid = int64(len(data)) == info.Size() && minisign.Verify(key, data, text)
	}
	if !valid {
		return errors.New("update signature verification failed")
	}
	// Older signatures have no version field. Accept them for installed-feed
	// compatibility, but enforce the authenticated binding whenever it is present.
	for _, field := range strings.Split(sig.TrustedComment, "\t") {
		if signed, ok := strings.CutPrefix(field, "version:"); ok {
			actual, err := normalizedVersion(signed)
			if err != nil {
				return errors.New("invalid signed update version")
			}
			announced, err := normalizedVersion(version)
			if err != nil || semver.Compare(actual, announced) != 0 {
				return errors.New("signed update version differs from release manifest")
			}
		}
	}
	return ctx.Err()
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

// SignArtifact writes path.sig as base64(minisign text), the representation
// installed Tauri clients consume. Private inputs and decryption errors are never
// included in returned error messages. version may be empty for legacy tooling.
func SignArtifact(ctx context.Context, path string, keyText []byte, password, version string) error {
	if len(keyText) == 0 || len(keyText) > maxKeyText {
		return errors.New("invalid signing private key length")
	}
	text, err := minisignText(string(keyText))
	if err != nil {
		return errors.New("invalid signing private key encoding")
	}
	var key minisign.PrivateKey
	if minisign.IsEncrypted(text) {
		key, err = minisign.DecryptKey(password, text)
	} else {
		err = key.UnmarshalText(text)
	}
	if err != nil {
		return errors.New("cannot unlock signing private key")
	}
	if version != "" {
		normalized, err := normalizedVersion(version)
		if err != nil {
			return err
		}
		version = strings.TrimPrefix(normalized, "v")
	}
	name := filepath.Base(path)
	if strings.ContainsAny(name, "\t\r\n") {
		return errors.New("invalid artifact filename")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return errors.New("cannot stat signing artifact")
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxArtifact {
		return errors.New("invalid signing artifact size or type")
	}
	file, err := os.Open(path)
	if err != nil {
		return errors.New("cannot open signing artifact")
	}
	defer file.Close()
	reader := minisign.NewReader(&contextReader{ctx: ctx, reader: io.LimitReader(file, maxArtifact+1)})
	n, err := io.Copy(io.Discard, reader)
	if err != nil {
		return fmt.Errorf("read signing artifact: %w", err)
	}
	after, err := file.Stat()
	if err != nil || n != info.Size() || !os.SameFile(info, after) || !info.ModTime().Equal(after.ModTime()) {
		return errors.New("signing artifact changed during read")
	}
	comment := "timestamp:" + strconv.FormatInt(time.Now().Unix(), 10) + "\tfile:" + name
	if version != "" {
		comment += "\tversion:" + version
	}
	signature := reader.SignWithComments(key, comment, "signature from nootify artifact signer")
	if !reader.Verify(key.Public().(minisign.PublicKey), signature) {
		return errors.New("invalid signing private key")
	}
	encoded := base64.StdEncoding.EncodeToString(signature) + "\n"
	temp, err := os.CreateTemp(filepath.Dir(path), ".nootify-signature-*")
	if err != nil {
		return errors.New("cannot create signature file")
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	defer temp.Close()
	if _, err = temp.WriteString(encoded); err != nil {
		return errors.New("cannot write signature file")
	}
	if err = temp.Chmod(0644); err != nil {
		return err
	}
	if err = temp.Sync(); err != nil {
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = os.Rename(tempPath, path+".sig"); err != nil {
		return errors.New("cannot replace signature file")
	}
	return nil
}
