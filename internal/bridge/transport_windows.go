//go:build windows

package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"time"

	winio "github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
)

var namedPipeRE = regexp.MustCompile(`(?i)^\\\\[.?]\\pipe\\[^\\/\x00-\x1f]+$`)

func checkSocket(path string) error {
	if !namedPipeRE.MatchString(path) {
		return fmt.Errorf("The configured inbox path must be a local Windows named pipe")
	}
	return nil
}
func processAlive(pid uint32) bool {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	state, err := windows.WaitForSingleObject(process, 0)
	return err == nil && state == uint32(windows.WAIT_TIMEOUT)
}
func dialNative(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeAccessImpLevel(ctx, path, windows.GENERIC_READ|windows.GENERIC_WRITE, winio.PipeImpLevelIdentification)
}
func writeInbox(ctx context.Context, path, content, token string, pid uint32, timeout time.Duration) (DeliveryResult, error) {
	if err := checkSocket(path); err != nil {
		return DeliveryResult{}, retry(err.Error())
	}
	if pid == 0 {
		return DeliveryResult{}, retry("Inbox peer authentication requires a live runtime PID")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := dialNative(ctx, path)
	if err != nil {
		return DeliveryResult{}, retry("Inbox connection is unavailable")
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	// Authenticate the exact connected pipe handle before sending even its auth
	// frame. Identification SQOS prevents a hostile server impersonating us.
	fd, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	var serverPID uint32
	if windows.GetNamedPipeServerProcessId(windows.Handle(fd.Fd()), &serverPID) != nil || serverPID != pid {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	process, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	defer windows.CloseHandle(process)
	alive := func() bool {
		state, e := windows.WaitForSingleObject(process, 0)
		return e == nil && state == uint32(windows.WAIT_TIMEOUT)
	}
	if !alive() {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	var peerToken windows.Token
	if windows.OpenProcessToken(process, windows.TOKEN_QUERY, &peerToken) != nil {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	defer peerToken.Close()
	current, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	peer, err := peerToken.GetTokenUser()
	if err != nil || !windows.EqualSid(current.User.Sid, peer.User.Sid) {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	var latestPID uint32
	if !alive() || windows.GetNamedPipeServerProcessId(windows.Handle(fd.Fd()), &latestPID) != nil || latestPID != pid {
		return DeliveryResult{}, retry("Inbox peer identity could not be verified")
	}
	payload := []byte{}
	if token != "" {
		frame, _ := json.Marshal(map[string]any{"type": "auth", "token": token})
		payload = append(payload, frame...)
		payload = append(payload, '\n')
	}
	frame, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
	payload = append(payload, frame...)
	payload = append(payload, '\n')
	deadline, _ := ctx.Deadline()
	_ = conn.SetWriteDeadline(deadline)
	if n, err := conn.Write(payload); err != nil || n != len(payload) {
		return DeliveryResult{}, uncertain("Inbox write failed; delivery is unconfirmed")
	}
	return DeliveryResult{Status: "socket_written"}, nil
}
