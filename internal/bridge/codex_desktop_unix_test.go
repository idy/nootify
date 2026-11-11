//go:build !windows

package bridge

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func desktopFixture(t *testing.T, s *Service, respond func(net.Conn, map[string]json.RawMessage) bool) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nootify-codex-")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", dir)
	if err = os.MkdirAll(filepath.Join(dir, "ipc"), 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "ipc", "ipc.sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close(); _ = os.RemoveAll(dir) })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			func() {
				defer conn.Close()
				for {
					frame, err := desktopRead(conn)
					if err != nil {
						return
					}
					if !respond(conn, frame) {
						return
					}
				}
			}()
		}
	}()
	codexFixture(t, s, "state_5.sqlite", 0)
}
func desktopReply(conn net.Conn, request map[string]json.RawMessage, result any, owner string) error {
	return desktopWrite(conn, map[string]any{"type": "response", "requestId": stringField(request, "requestId"), "method": stringField(request, "method"), "handledByClientId": owner, "resultType": "success", "result": result})
}
func TestCodexDesktopOwnerRouterIdleFallbackAndDiscovery(t *testing.T) {
	s := testService(t)
	methods := []string{}
	var mu sync.Mutex
	discoveryReply := make(chan bool, 1)
	desktopFixture(t, s, func(conn net.Conn, request map[string]json.RawMessage) bool {
		if stringField(request, "type") == "client-discovery-response" {
			discoveryReply <- true
			return true
		}
		method := stringField(request, "method")
		mu.Lock()
		methods = append(methods, method)
		mu.Unlock()
		var result any = map[string]any{}
		owner := "desktop-owner"
		var params map[string]any
		_ = json.Unmarshal(request["params"], &params)
		switch method {
		case "initialize":
			owner = "nootify-client"
			result = map[string]any{"clientId": "nootify-client"}
			_ = desktopWrite(conn, map[string]any{"type": "client-discovery-request", "requestId": "discovery"})
		case "thread-owner-discovery":
			if params["conversationId"] != "thread-selected" {
				t.Error("owner discovery is not targeted")
			}
			result = map[string]any{"supportsUntrustedAppInput": true}
		case "thread-follower-read-model-settings":
			if stringField(request, "targetClientId") != "desktop-owner" {
				t.Error("missing owner target")
			}
			result = map[string]any{"settings": map[string]any{"resumeState": "resumed"}}
		case "thread-follower-steer-turn":
			_ = desktopWrite(conn, map[string]any{"type": "response", "requestId": stringField(request, "requestId"), "resultType": "error", "error": "Cannot steer conversation thread-selected because its active turn already ended"})
			return true
		case "thread-follower-start-turn":
			turn := params["turnStart"].(map[string]any)
			if turn["context"].(map[string]any)["inheritThreadSettings"] != true {
				t.Error("did not inherit owner settings")
			}
			result = map[string]any{"result": map[string]any{"turn": map[string]any{"id": "new-turn"}}}
		default:
			t.Errorf("unsafe desktop method %s", method)
		}
		return desktopReply(conn, request, result, owner) == nil
	})
	observed := PublicSession{SessionName: "Selected"}
	result, err := s.sendCodexDesktop(context.Background(), "thread-selected", "hello", &observed)
	if err != nil || result.Status != "input_accepted" {
		t.Fatalf("desktop send %v %v", result, err)
	}
	select {
	case <-discoveryReply:
	default:
		t.Fatal("desktop discovery was not explicitly declined")
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"initialize", "thread-owner-discovery", "thread-follower-read-model-settings", "thread-follower-steer-turn", "thread-follower-start-turn"}
	if !reflect.DeepEqual(methods, want) {
		t.Fatalf("desktop flow %v", methods)
	}
}
func TestCodexDesktopMutationReceiptFailuresNeverReplay(t *testing.T) {
	for _, mode := range []string{"disconnect", "wrong-owner", "wrong-method", "missing-turn", "wrong-idle-guard", "offline", "unsupported"} {
		t.Run(mode, func(t *testing.T) {
			s := testService(t)
			mutations := 0
			var mu sync.Mutex
			desktopFixture(t, s, func(conn net.Conn, request map[string]json.RawMessage) bool {
				method := stringField(request, "method")
				switch method {
				case "initialize":
					return desktopReply(conn, request, map[string]any{"clientId": "client"}, "client") == nil
				case "thread-owner-discovery":
					return desktopReply(conn, request, map[string]any{"supportsUntrustedAppInput": true}, "owner") == nil
				case "thread-follower-read-model-settings":
					return desktopReply(conn, request, map[string]any{"settings": map[string]any{"resumeState": "resumed"}}, "owner") == nil
				case "thread-follower-steer-turn":
					mu.Lock()
					mutations++
					mu.Unlock()
					switch mode {
					case "disconnect":
						return false
					case "wrong-owner":
						return desktopReply(conn, request, map[string]any{"result": map[string]any{"turnId": "turn"}}, "other-owner") == nil
					case "wrong-method":
						request["method"] = json.RawMessage(`"another-method"`)
						return desktopReply(conn, request, map[string]any{"result": map[string]any{"turnId": "turn"}}, "owner") == nil
					case "missing-turn":
						return desktopReply(conn, request, map[string]any{"result": map[string]any{}}, "owner") == nil
					default:
						reason := "Cannot steer conversation thread-selected because inactive"
						if mode == "offline" {
							reason = "no-client-found"
						}
						if mode == "unsupported" {
							reason = "request-version-mismatch"
						}
						return desktopWrite(conn, map[string]any{"type": "response", "requestId": stringField(request, "requestId"), "resultType": "error", "error": reason}) == nil
					}
				default:
					t.Errorf("replayed uncertain input via %s", method)
					return false
				}
			})
			_, err := s.sendCodexDesktop(context.Background(), "thread-selected", "hello", &PublicSession{SessionName: "Selected"})
			if mode == "offline" {
				assertDelivery(t, err, "session_offline", false, false)
			} else if mode == "unsupported" {
				assertDelivery(t, err, "unsupported_adapter", false, false)
			} else {
				assertDelivery(t, err, "delivery_unconfirmed", false, true)
			}
			mu.Lock()
			defer mu.Unlock()
			if mutations != 1 {
				t.Fatalf("mutations=%d", mutations)
			}
		})
	}
}
func TestCodexDesktopOfflineOwnerCannotResume(t *testing.T) {
	s := testService(t)
	desktopFixture(t, s, func(conn net.Conn, request map[string]json.RawMessage) bool {
		switch stringField(request, "method") {
		case "initialize":
			return desktopReply(conn, request, map[string]any{"clientId": "client"}, "client") == nil
		case "thread-owner-discovery":
			return desktopReply(conn, request, map[string]any{"supportsUntrustedAppInput": true}, "owner") == nil
		case "thread-follower-read-model-settings":
			return desktopReply(conn, request, map[string]any{"settings": map[string]any{"resumeState": "not-resumed"}}, "owner") == nil
		default:
			t.Error("inactive owner received a mutation")
			return false
		}
	})
	_, err := s.sendCodexDesktop(context.Background(), "thread-selected", "hello", &PublicSession{SessionName: "Selected"})
	assertDelivery(t, err, "session_offline", false, false)
}
