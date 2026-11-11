package bridge

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"time"
)

const maxDesktopFrame = 8 * 1024 * 1024

var errInactiveTurn = errors.New("Codex Desktop active turn ended")

type desktopClient struct {
	conn     net.Conn
	clientID string
}
type desktopReceipt struct {
	owner  string
	result json.RawMessage
}

func desktopWrite(conn net.Conn, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return httpError(400, "Desktop request could not be serialized")
	}
	if len(raw) > maxDesktopFrame {
		return httpError(413, "Codex Desktop input is too large")
	}
	frame := make([]byte, 4+len(raw))
	binary.LittleEndian.PutUint32(frame, uint32(len(raw)))
	copy(frame[4:], raw)
	for len(frame) > 0 {
		n, err := conn.Write(frame)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}
func desktopRead(conn net.Conn) (map[string]json.RawMessage, error) {
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(header[:])
	if n == 0 || n > maxDesktopFrame {
		return nil, errors.New("Invalid desktop frame")
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(conn, body); err != nil {
		return nil, err
	}
	var frame map[string]json.RawMessage
	err := json.Unmarshal(body, &frame)
	return frame, err
}
func stringField(frame map[string]json.RawMessage, key string) string {
	var v string
	_ = json.Unmarshal(frame[key], &v)
	return v
}
func (d *desktopClient) request(ctx context.Context, method string, version int, params any, owner string, mutation bool, idleGuard string) (desktopReceipt, error) {
	if ctx.Err() != nil {
		return desktopReceipt{}, retry("Codex Desktop request canceled before submission")
	}
	timeout := 8 * time.Second
	if mutation {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	_ = d.conn.SetDeadline(deadline)
	fail := func() (desktopReceipt, error) {
		if mutation {
			return desktopReceipt{}, uncertain("Codex Desktop input receipt was not received; delivery is unconfirmed")
		}
		return desktopReceipt{}, retry("Codex Desktop is unavailable")
	}
	requestID := newID()
	request := map[string]any{"type": "request", "requestId": requestID, "sourceClientId": d.clientID, "version": version, "method": method, "params": params, "timeoutMs": timeout.Milliseconds()}
	if owner != "" {
		request["targetClientId"] = owner
	}
	// Serialization/size errors precede all writes and can be rejected definitively.
	raw, err := json.Marshal(request)
	if err != nil {
		return desktopReceipt{}, httpError(400, "Desktop request could not be serialized")
	}
	if len(raw) > maxDesktopFrame {
		return desktopReceipt{}, httpError(413, "Codex Desktop input is too large")
	}
	if desktopWrite(d.conn, request) != nil {
		return fail()
	}
	for {
		frame, err := desktopRead(d.conn)
		if err != nil {
			return fail()
		}
		kind := stringField(frame, "type")
		if kind == "client-discovery-request" {
			id := stringField(frame, "requestId")
			if id != "" {
				if desktopWrite(d.conn, map[string]any{"type": "client-discovery-response", "requestId": id, "response": map[string]any{"canHandle": false}}) != nil {
					return fail()
				}
			}
			continue
		}
		if kind != "response" || stringField(frame, "requestId") != requestID {
			continue
		}
		if stringField(frame, "resultType") != "success" {
			reason := stringField(frame, "error")
			if idleGuard != "" && reason == idleGuard {
				return desktopReceipt{}, errInactiveTurn
			}
			switch reason {
			case "no-client-found":
				return desktopReceipt{}, unavailable("session_offline")
			case "request-version-mismatch", "no-handler-for-request":
				return desktopReceipt{}, unavailable("unsupported_adapter")
			}
			return fail()
		}
		handled := stringField(frame, "handledByClientId")
		if stringField(frame, "method") != method || handled == "" || (owner != "" && handled != owner) {
			return fail()
		}
		return desktopReceipt{owner: handled, result: frame["result"]}, nil
	}
}
func (d *desktopClient) ready(ctx context.Context, id string) (string, error) {
	receipt, err := d.request(ctx, "thread-owner-discovery", 1, map[string]any{"hostId": "local", "conversationId": id}, "", false, "")
	if err != nil {
		return "", err
	}
	var supported struct {
		Supports bool `json:"supportsUntrustedAppInput"`
	}
	if json.Unmarshal(receipt.result, &supported) != nil || !supported.Supports {
		return "", unavailable("unsupported_adapter")
	}
	owner := receipt.owner
	receipt, err = d.request(ctx, "thread-follower-read-model-settings", 1, map[string]any{"conversationId": id}, owner, false, "")
	if err != nil {
		return "", err
	}
	var settings struct {
		Settings struct {
			ResumeState string `json:"resumeState"`
		} `json:"settings"`
	}
	if json.Unmarshal(receipt.result, &settings) != nil || settings.Settings.ResumeState != "resumed" {
		return "", unavailable("session_offline")
	}
	return owner, nil
}
func (s *Service) sendCodexDesktop(ctx context.Context, id, text string, observed *PublicSession) (DeliveryResult, error) {
	path := filepath.Join(s.codexHome(), "ipc", "ipc.sock")
	if checkSocket(path) != nil {
		return DeliveryResult{}, retry("Codex Desktop connection is unavailable")
	}
	connectCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	conn, err := dialNative(connectCtx, path)
	cancel()
	if err != nil {
		return DeliveryResult{}, retry("Codex Desktop connection is unavailable")
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	d := desktopClient{conn: conn, clientID: "initializing-client"}
	receipt, err := d.request(ctx, "initialize", 0, map[string]any{"clientType": "nootify"}, "", false, "")
	if err != nil {
		return DeliveryResult{}, err
	}
	var init struct {
		ClientID string `json:"clientId"`
	}
	if json.Unmarshal(receipt.result, &init) != nil || init.ClientID == "" || receipt.owner != init.ClientID {
		return DeliveryResult{}, retry("Invalid Codex Desktop initialization receipt")
	}
	d.clientID = init.ClientID
	owner, err := d.ready(ctx, id)
	if err != nil {
		return DeliveryResult{}, err
	}
	observed.Availability = "active"
	if err = s.checkCodexArchive(ctx, id); err != nil {
		return DeliveryResult{}, err
	}
	messageID := newID()
	text = "[Nootify: " + observed.SessionName + "]\n" + text
	input := []any{map[string]any{"type": "text", "text": text, "text_elements": []any{}}}
	receipt, err = d.request(ctx, "thread-follower-steer-turn", 1, map[string]any{"conversationId": id, "clientUserMessageId": messageID, "input": input, "restoreMessage": map[string]any{"id": messageID, "text": text, "cwd": nil, "createdAt": time.Now().UnixMilli(), "context": map[string]any{"prompt": text, "addedFiles": []any{}, "fileAttachments": []any{}, "imageAttachments": []any{}, "commentAttachments": []any{}, "ideContext": nil, "workspaceRoots": []any{}}}}, owner, true, "Cannot steer conversation "+id+" because its active turn already ended")
	started := false
	if errors.Is(err, errInactiveTurn) {
		started = true
		if err = s.checkCodexArchive(ctx, id); err != nil {
			return DeliveryResult{}, err
		}
		receipt, err = d.request(ctx, "thread-follower-start-turn", 2, map[string]any{"conversationId": id, "turnStart": map[string]any{"request": map[string]any{"threadId": id, "clientUserMessageId": messageID, "input": input}, "context": map[string]any{"inheritThreadSettings": true}}}, owner, true, "")
	}
	if err != nil {
		return DeliveryResult{}, err
	}
	var result struct {
		Result struct {
			TurnID string `json:"turnId"`
			Turn   struct {
				ID string `json:"id"`
			} `json:"turn"`
		} `json:"result"`
	}
	if json.Unmarshal(receipt.result, &result) != nil || (!started && result.Result.TurnID == "") || (started && result.Result.Turn.ID == "") {
		return DeliveryResult{}, uncertain("Codex Desktop did not return an input receipt; delivery is unconfirmed")
	}
	return DeliveryResult{Status: "input_accepted"}, nil
}
