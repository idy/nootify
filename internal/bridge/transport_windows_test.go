//go:build windows

package bridge

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	winio "github.com/tailscale/go-winio"
)

func TestWindowsInboxLocalPipeSyntax(t *testing.T) {
	for _, path := range []string{`\\.\pipe\local-inbox`, `\\?\pipe\local-inbox`} {
		if err := checkSocket(path); err != nil {
			t.Errorf("local pipe rejected %q: %v", path, err)
		}
	}
	for _, path := range []string{`\\remote\pipe\inbox`, `C:\inbox`, `\\.\pipe\nested\inbox`, `\\.\pipe\`, `\\.\pipe\inbox` + "\n"} {
		if err := checkSocket(path); err == nil {
			t.Errorf("unsafe pipe allowed %q", path)
		}
	}
	_, err := writeInbox(context.Background(), `\\.\pipe\unused`, "private", "secret", 0, time.Second)
	assertDelivery(t, err, "backend_unavailable", true, false)
}
func TestWindowsInboxAuthenticatesConnectedPIDBeforeAnyFrames(t *testing.T) {
	for _, validPeer := range []bool{true, false} {
		name := "wrong-peer"
		if validPeer {
			name = "same-peer"
		}
		t.Run(name, func(t *testing.T) {
			path := `\\.\pipe\nootify-bridge-test-` + newID()
			listener, err := winio.ListenPipe(path, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			received := make(chan []byte, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				data, _ := io.ReadAll(conn)
				received <- data
			}()
			expected := uint32(os.Getpid())
			if !validPeer {
				expected += 100000
			}
			result, err := writeInbox(context.Background(), path, "private text", "secret", expected, time.Second)
			if validPeer {
				if err != nil || result.Status != "socket_written" {
					t.Fatalf("authenticated delivery: %v %v", result, err)
				}
			} else {
				assertDelivery(t, err, "backend_unavailable", true, false)
			}
			select {
			case data := <-received:
				if validPeer {
					if !strings.Contains(string(data), `"type":"auth"`) || !strings.Contains(string(data), "private text") {
						t.Fatalf("missing frames %s", data)
					}
				} else if len(data) != 0 {
					t.Fatalf("frames leaked before PID authentication: %s", data)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("pipe connection was not closed")
			}
		})
	}
}
