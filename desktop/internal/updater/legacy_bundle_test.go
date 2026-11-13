package updater

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// CI opts in after packaging so the actual archive, embedded native signatures,
// and old launcher invocation are checked together without running any service.
func TestMacPackagedUpdateCompatibility(t *testing.T) {
	archive := os.Getenv("NOOTIFY_TEST_MAC_UPDATE_ARCHIVE")
	if runtime.GOOS != "darwin" || archive == "" {
		t.Skip("requires the packaged macOS updater archive")
	}
	destination := t.TempDir()
	if err := extractApp(context.Background(), archive, destination, defaultArchiveLimits); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(destination, "Nootify.app")
	// Frozen v0.2.1 validateBundle contract: these are regular, nonempty files,
	// with executable permissions under MacOS. A symlink cannot satisfy it.
	for _, name := range []string{"Contents/MacOS/Nootify", "Contents/MacOS/node", "Contents/MacOS/nootify-core", "Contents/MacOS/nootify-tsnet", "Contents/Resources/service/dist/src/cli.js", "Contents/Resources/service/dist/src/server.js", "Contents/Info.plist"} {
		info, err := os.Lstat(filepath.Join(app, filepath.FromSlash(name)))
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			t.Fatalf("legacy updater requires regular file %s: %v", name, err)
		}
		if strings.HasPrefix(name, "Contents/MacOS/") && info.Mode()&0111 == 0 {
			t.Fatalf("legacy updater requires executable %s", name)
		}
	}
	if output, err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", app).CombinedOutput(); err != nil {
		t.Fatalf("extracted app signature: %v: %s", err, output)
	}
	command := exec.Command(filepath.Join(app, "Contents", "MacOS", "node"), filepath.Join(app, "Contents", "Resources", "service", "dist", "src", "cli.js"), "health", "--help")
	command.Env = append(os.Environ(), "NODE_OPTIONS=--require=/missing/injected.js")
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "Nootify serve") {
		t.Fatalf("legacy CLI invocation did not reach Go: %v: %s", err, output)
	}
}
