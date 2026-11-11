//go:build !windows

package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"time"
)

func processAlive(pid uint32) bool { return syscall.Kill(int(pid), 0) == nil }
func checkSocket(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("The configured inbox path is not a socket")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("The inbox belongs to another OS user")
	}
	return nil
}
func dialNative(ctx context.Context, path string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
func writeInbox(ctx context.Context, path, content, token string, pid uint32, timeout time.Duration) (DeliveryResult, error) {
	if err := checkSocket(path); err != nil {
		return DeliveryResult{}, retry(err.Error())
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
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	payload := []byte{}
	if token != "" {
		frame, _ := json.Marshal(map[string]any{"type": "auth", "token": token})
		payload = append(payload, frame...)
		payload = append(payload, '\n')
	}
	frame, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
	payload = append(payload, frame...)
	payload = append(payload, '\n')
	// From the first write onward, loss of the EOF receipt is ambiguous. Never
	// reconnect or replay the message after an interrupted write.
	if n, err := conn.Write(payload); err != nil || n != len(payload) {
		return DeliveryResult{}, uncertain("Inbox write failed; delivery is unconfirmed")
	}
	if unix, ok := conn.(*net.UnixConn); ok {
		if err = unix.CloseWrite(); err != nil {
			return DeliveryResult{}, uncertain("Inbox exchange did not finish")
		}
	}
	var buf [4096]byte
	received := 0
	for {
		n, e := conn.Read(buf[:])
		received += n
		if received > 65536 {
			return DeliveryResult{}, uncertain("Inbox response exceeded the read limit")
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			return DeliveryResult{}, uncertain("Inbox response was not received; delivery is unconfirmed")
		}
	}
	return DeliveryResult{Status: "socket_written"}, nil
}
