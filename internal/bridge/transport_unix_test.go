//go:build !windows

package bridge

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func socketListener(t *testing.T) (net.Listener, string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "nootify-bridge-")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "inbox.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		os.RemoveAll(dir)
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close(); _ = os.RemoveAll(dir) })
	return l, path
}
func fixtureRuntime(t *testing.T, s *Service, id, host, path string) {
	t.Helper()
	jsonFile(t, filepath.Join(s.options.Home, ".claude", "sessions", "123.json"), runtimeRecord{PID: uint32(os.Getpid()), SessionID: id, HostSessionID: host, SocketPath: path, Name: "Live runtime"})
}
func desktopMetadata(t *testing.T, s *Service, id string, archived any) {
	t.Helper()
	jsonFile(t, filepath.Join(s.desktopRoots()[0], "account", "profile", id+".json"), map[string]any{"sessionId": id, "cliSessionId": "cli-selected", "title": "Selected desktop", "isArchived": archived})
}
func TestNativeSelectedSessionTokenAndArchiveChecks(t *testing.T) {
	s := testService(t)
	listener, path := socketListener(t)
	fixtureRuntime(t, s, "cli-selected", "local_selected", path)
	desktopMetadata(t, s, "local_selected", false)
	received := make(chan string, 2)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			data, _ := io.ReadAll(conn)
			received <- string(data)
			_ = conn.Close()
		}
	}()
	if err := s.register("local_selected", sessionRecord{PublicSession: PublicSession{Adapter: "claude-desktop", SessionName: "Saved"}, SocketPath: path, SocketToken: "secret"}); err != nil {
		t.Fatal(err)
	}
	// Unrelated corrupt metadata is not opened during targeted lookup.
	unrelated := filepath.Join(s.desktopRoots()[0], "account", "profile", "local_other.json")
	if err := os.WriteFile(unrelated, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := s.Send(context.Background(), "local_selected", "hello", "claude-desktop", nil)
	if err != nil || result.Status != "socket_written" {
		t.Fatalf("native send %v %v", result, err)
	}
	frames := strings.Split(strings.TrimSpace(<-received), "\n")
	if len(frames) != 2 {
		t.Fatalf("frames %v", frames)
	}
	var auth, user map[string]any
	_ = json.Unmarshal([]byte(frames[0]), &auth)
	_ = json.Unmarshal([]byte(frames[1]), &user)
	if auth["token"] != "secret" || user["message"].(map[string]any)["content"] != "[Nootify: Selected desktop]\nhello" {
		t.Fatalf("wrong frames %v %v", auth, user)
	}
	desktopMetadata(t, s, "local_selected", true)
	_, err = s.Send(context.Background(), "local_selected", "blocked", "claude-desktop", nil)
	assertDelivery(t, err, "session_archived", false, false)
	desktopMetadata(t, s, "local_selected", nil)
	_, err = s.Send(context.Background(), "local_selected", "unknown", "claude-desktop", nil)
	assertDelivery(t, err, "archive_unknown", false, false)
	desktopMetadata(t, s, "local_selected", false)
	_ = os.Remove(filepath.Join(s.options.Home, ".claude", "sessions", "123.json"))
	_, err = s.Send(context.Background(), "local_selected", "offline", "claude-desktop", nil)
	assertDelivery(t, err, "session_offline", false, false)
	select {
	case extra := <-received:
		t.Fatalf("blocked session received %s", extra)
	default:
	}
}
func TestNativeTokenOnlyMatchesSelectedSocket(t *testing.T) {
	s := testService(t)
	listener, path := socketListener(t)
	fixtureRuntime(t, s, "selected", "", path)
	if err := s.options.Store.Put("sessions", "selected", sessionRecord{PublicSession: PublicSession{SessionID: "selected", HostID: s.host, Adapter: "claude-code", SessionName: "Saved"}, SocketPath: path + "-old", SocketToken: "never-leak"}); err != nil {
		t.Fatal(err)
	}
	received := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		data, _ := io.ReadAll(conn)
		received <- string(data)
	}()
	if _, err := s.Send(context.Background(), "selected", "new socket", "claude-code", nil); err != nil {
		t.Fatal(err)
	}
	data := <-received
	if strings.Contains(data, "never-leak") || strings.Contains(data, `"type":"auth"`) {
		t.Fatalf("saved token leaked to new endpoint: %s", data)
	}
	public, _ := json.Marshal(s.List())
	if strings.Contains(string(public), path) || strings.Contains(string(public), "never-leak") {
		t.Fatalf("private transport metadata leaked: %s", public)
	}
}
func TestSocketWriteFailureClassificationAndValidation(t *testing.T) {
	s := testService(t)
	file := filepath.Join(s.options.Home, "regular")
	if err := os.WriteFile(file, []byte("not socket"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := writeInbox(context.Background(), file, "private", "", 0, time.Second)
	assertDelivery(t, err, "backend_unavailable", true, false)
	listener, path := socketListener(t)
	received := make(chan struct{})
	release := make(chan struct{})
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.ReadAll(conn)
		close(received)
		<-release
	}()
	_, err = writeInbox(context.Background(), path, "accepted but no EOF", "", 0, 40*time.Millisecond)
	close(release)
	assertDelivery(t, err, "delivery_unconfirmed", false, true)
	select {
	case <-received:
	case <-time.After(time.Second):
		t.Fatal("server never received submitted input")
	}
}
func TestDuplicateDesktopMetadataFailsClosed(t *testing.T) {
	s := testService(t)
	desktopMetadata(t, s, "local_selected", false)
	jsonFile(t, filepath.Join(s.desktopRoots()[1], "other-account", "profile", "local_selected.json"), map[string]any{"sessionId": "local_selected", "isArchived": false})
	_, err := s.Send(context.Background(), "local_selected", "ambiguous", "claude-desktop", nil)
	assertDelivery(t, err, "archive_unknown", false, false)
}
func TestCloseCancelsInFlightNativeExchange(t *testing.T) {
	s := testService(t)
	listener, path := socketListener(t)
	fixtureRuntime(t, s, "selected", "", path)
	received := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.ReadAll(conn)
		close(received)
		<-release
	}()
	done := make(chan error, 1)
	go func() {
		_, err := s.Send(context.Background(), "selected", "in flight", "claude-code", nil)
		done <- err
	}()
	<-received
	_ = s.Close()
	select {
	case err := <-done:
		assertDelivery(t, err, "delivery_unconfirmed", false, true)
	case <-time.After(time.Second):
		t.Fatal("Close did not cancel active transport")
	}
}
