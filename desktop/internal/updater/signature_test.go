package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aead.dev/minisign"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/scrypt"
)

func syntheticKey(t *testing.T) (string, []byte, minisign.PrivateKey) {
	t.Helper()
	public, private, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := public.MarshalText()
	priv, _ := private.MarshalText()
	return base64.StdEncoding.EncodeToString(pub), priv, private
}
func writeTemp(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func signedBytes(t *testing.T, private minisign.PrivateKey, data []byte) string {
	t.Helper()
	reader := minisign.NewReader(bytes.NewReader(data))
	buffer := make([]byte, 1024)
	for {
		n, _ := reader.Read(buffer)
		if n == 0 {
			break
		}
	}
	return base64.StdEncoding.EncodeToString(reader.Sign(private))
}

func TestLegacyRustMinisignFixtures(t *testing.T) {
	// Published minisign-verify 0.3.0 fixtures; both formats were used by Tauri.
	key := "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
	signatures := []string{
		"untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==",
		"untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
	}
	artifact := writeTemp(t, "artifact", []byte("test"))
	for _, signature := range signatures {
		if err := verifyArtifact(context.Background(), artifact, base64.StdEncoding.EncodeToString([]byte(key)), base64.StdEncoding.EncodeToString([]byte(signature)), "1.0.0"); err != nil {
			t.Fatal(err)
		}
		tampered := strings.Replace(signature, "file:test", "file:evil", 1)
		if err := verifyArtifact(context.Background(), artifact, key, tampered, "1.0.0"); err == nil {
			t.Fatal("accepted modified authenticated comment")
		}
	}
	if _, err := parsePublicKey(DefaultPublicKey); err != nil {
		t.Fatal("preserved embedded key", err)
	}
}

func TestSignerAndVerification(t *testing.T) {
	public, private, _ := syntheticKey(t)
	data := []byte("synthetic release artifact")
	artifact := writeTemp(t, "Nootify.app.tar.gz", data)
	if err := SignArtifact(context.Background(), artifact, []byte(base64.StdEncoding.EncodeToString(private)), "", "1.2.3"); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(artifact + ".sig")
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyArtifact(context.Background(), artifact, public, string(encoded), "v1.2.3"); err != nil {
		t.Fatal(err)
	}
	if err = verifyArtifact(context.Background(), artifact, public, string(encoded), "1.2.4"); err == nil {
		t.Fatal("accepted mismatched signed version")
	}
	// Independently verify bytes in the exact old-client envelope, including the
	// ED algorithm tag, little-endian key ID and signature over trusted comments.
	text, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	lines := strings.Split(string(text), "\n")
	pubText, _ := base64.StdEncoding.DecodeString(public)
	pubLines := strings.Split(string(pubText), "\n")
	pubRaw, _ := base64.StdEncoding.DecodeString(pubLines[1])
	raw, _ := base64.StdEncoding.DecodeString(lines[1])
	global, _ := base64.StdEncoding.DecodeString(lines[3])
	digest := blake2b.Sum512(data)
	if string(raw[:2]) != "ED" || !bytes.Equal(raw[2:10], pubRaw[2:10]) || !ed25519.Verify(pubRaw[10:], digest[:], raw[10:]) || !ed25519.Verify(pubRaw[10:], append(raw[10:], []byte(strings.TrimPrefix(lines[2], "trusted comment: "))...), global) {
		t.Fatal("not a legacy-compatible minisign signature")
	}
	if err = os.WriteFile(artifact, []byte("modified artifact"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = verifyArtifact(context.Background(), artifact, public, string(encoded), "1.2.3"); err == nil {
		t.Fatal("accepted corrupted artifact")
	}
	wrongPublic, _, _ := syntheticKey(t)
	if err = verifyArtifact(context.Background(), artifact, wrongPublic, string(encoded), "1.2.3"); err == nil {
		t.Fatal("accepted wrong key")
	}
	for _, bad := range []string{"", "garbage", strings.Repeat("a", maxKeyText+1), base64.StdEncoding.EncodeToString([]byte("untrusted comment: bad\nnot-a-signature"))} {
		if err = verifyArtifact(context.Background(), artifact, public, bad, "1.2.3"); err == nil {
			t.Fatalf("accepted malformed signature %q", bad[:min(len(bad), 20)])
		}
	}
}

// Generate a synthetic minisign encrypted box with low test-only scrypt costs.
// Production keys retain their encoded parameters, enforced by the library.
func encryptedTestKey(t *testing.T, private []byte, password string) []byte {
	t.Helper()
	lines := strings.Split(string(private), "\n")
	raw, err := base64.StdEncoding.DecodeString(lines[1])
	if err != nil {
		t.Fatal(err)
	}
	plaintext := append([]byte(nil), raw[54:126]...)
	checksum := blake2b.Sum256(append([]byte("Ed"), plaintext...))
	payload := append(plaintext, checksum[:]...)
	binary.LittleEndian.PutUint16(raw[2:], 0x6353)
	binary.LittleEndian.PutUint64(raw[38:], 32768)
	binary.LittleEndian.PutUint64(raw[46:], 1048576)
	stream, err := scrypt.Key([]byte(password), raw[6:38], 1024, 8, 1, 104)
	if err != nil {
		t.Fatal(err)
	}
	for i := range payload {
		raw[54+i] = payload[i] ^ stream[i]
	}
	return []byte("untrusted comment: minisign encrypted secret key\n" + base64.StdEncoding.EncodeToString(raw))
}

func TestEncryptedKeyAndSecretFreeErrors(t *testing.T) {
	public, private, _ := syntheticKey(t)
	encrypted := encryptedTestKey(t, private, "synthetic-password")
	artifact := writeTemp(t, "app.exe", []byte("fake artifact"))
	if err := SignArtifact(context.Background(), artifact, encrypted, "synthetic-password", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	sig, _ := os.ReadFile(artifact + ".sig")
	if err := verifyArtifact(context.Background(), artifact, public, string(sig), "1.0.0"); err != nil {
		t.Fatal(err)
	}
	for _, key := range [][]byte{encrypted, []byte("private-super-secret-invalid-value")} {
		err := SignArtifact(context.Background(), artifact, key, "wrong-secret-password", "")
		if err == nil || strings.Contains(err.Error(), "secret-password") || strings.Contains(err.Error(), "super-secret") {
			t.Fatal("bad signing error", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := SignArtifact(ctx, artifact, private, "", ""); err == nil {
		t.Fatal("ignored cancellation")
	}
}
