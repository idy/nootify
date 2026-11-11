package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/idy/nootify/internal/host"
)

func TestRootHelpDoesNotLaunchNativeUI(t *testing.T) {
	var output, stderr bytes.Buffer
	handled, err := Run(context.Background(), []string{"--help"}, "test", &output, &stderr)
	if err != nil || !handled || !strings.Contains(output.String(), "Nootify") {
		t.Fatalf("help: %t %v %s", handled, err, output.String())
	}
	handled, err = Run(context.Background(), nil, "test", &output, &stderr)
	if err != nil || handled {
		t.Fatal("default desktop entry was intercepted")
	}
}
func TestGoCLIControlRoundTrip(t *testing.T) {
	for _, key := range []string{"LARK_APP_ID", "LARK_APP_SECRET", "LARK_NOTIFY_OPEN_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"} {
		t.Setenv(key, "")
	}
	server, err := host.New(context.Background(), host.Options{StateDir: t.TempDir(), Home: t.TempDir(), Port: 0, Version: "cli-test", Executable: "/synthetic/nootify", Assets: fstest.MapFS{"index.html": {Data: []byte("ui")}}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	base, _ := url.Parse(server.URL())
	run := func(args ...string) map[string]any {
		t.Helper()
		var output, stderr bytes.Buffer
		args = append(args, "--state-dir", server.State().Directory, "--port", base.Port())
		handled, err := Run(context.Background(), args, "cli-test", &output, &stderr)
		if err != nil || !handled {
			t.Fatalf("CLI %v: %v %s", args, err, stderr.String())
		}
		var result map[string]any
		if err = json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatalf("CLI result %s: %v", output.String(), err)
		}
		return result
	}
	health := run("health")
	if health["backend"] != "go" {
		t.Fatal(health)
	}
	registered := run("register", "--session-id", "test-polled", "--adapter", "trae", "--session-name", "Go CLI")
	if registered["adapter"] != "trae" {
		t.Fatal(registered)
	}
	sent := run("send", "--adapter", "trae", "--session-id", "test-polled", "--text", "hello from Go")
	if sent["status"] != "inbox_queued" {
		t.Fatal(sent)
	}
	inbox := run("thread-receive", "--agent", "trae", "--session-id", "test-polled")
	messages := inbox["messages"].([]any)
	if len(messages) != 1 {
		t.Fatal(inbox)
	}
	messageID := messages[0].(map[string]any)["id"].(string)
	run("thread-ack", "--agent", "trae", "--session-id", "test-polled", "--message-id", messageID)
	inbox = run("thread-receive", "--agent", "trae", "--session-id", "test-polled")
	if len(inbox["messages"].([]any)) != 0 {
		t.Fatal("ack did not persist")
	}
}
