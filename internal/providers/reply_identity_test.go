package providers

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func TestReplyIdentityMatchesNodeEraCallbackContract(t *testing.T) {
	reference := `{"origin_node_id":"origin","provider_id":"provider","message_id":"om_original","thread_id":"omt_original"}`
	encoded := base64.RawURLEncoding.EncodeToString([]byte(reference))
	payload := `{"message":{"message":` + reference + `},"content":{"text":"hello & 你好"}}`
	sum := sha256.Sum256([]byte(payload))
	if got := defaultReplyID(encoded, true, map[string]any{"text": "hello & 你好"}); got != hex.EncodeToString(sum[:]) {
		t.Fatalf("old provider callback fingerprint changed: %s", got)
	}
	payload = `{"message":{"message_id":"om_original"},"content":{"text":"reply"}}`
	sum = sha256.Sum256([]byte(payload))
	if got := defaultReplyID("om_original", false, map[string]any{"text": "reply"}); got != hex.EncodeToString(sum[:]) {
		t.Fatalf("old legacy callback fingerprint changed: %s", got)
	}
}
