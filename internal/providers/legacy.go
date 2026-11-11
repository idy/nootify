package providers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/idy/nootify/internal/httpx"
)

// legacyCallback only accepts a retained, actually forwarded legacy message and
// its original enabled legacy bot. It cannot be used to choose another chat.
func (s *Service) legacyCallback(ctx context.Context, id, action, text string) (any, error) {
	s.legacyMu.Lock()
	defer s.legacyMu.Unlock()
	var delivery map[string]any
	ok, err := s.options.Store.Get("lark_deliveries", id, &delivery)
	if err != nil {
		return nil, err
	}
	if !ok {
		rows, err := s.options.Store.Rows("inbox_messages")
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			source := asMap(asMap(row.Value)["source"])
			candidate := asMap(source["delivery"])
			if source["channel"] == "feishu" && candidate["message_id"] == id {
				delivery = candidate
				ok = true
				break
			}
		}
	}
	if !ok {
		return nil, httpx.Fail(404, "No forwarded Feishu message with this ID")
	}
	if delivery["transport_status"] == "ignored" {
		return nil, httpx.Fail(409, "This message was not forwarded")
	}
	s.ops.Lock()
	compat, err := s.compatibility(ctx)
	if err != nil {
		s.ops.Unlock()
		return nil, err
	}
	config, err := s.raw(ctx, "config.export", nil)
	s.ops.Unlock()
	if err != nil {
		return nil, err
	}
	credentials := asMap(compat["credentials"])
	valid := false
	for _, provider := range listMaps(asMap(config)["providers"]) {
		if provider["id"] == "legacy-feishu" && provider["type"] == "feishu" && provider["enabled"] == true && provider["app_id"] == credentials["appId"] {
			valid = true
		}
	}
	if !valid {
		return nil, httpx.Fail(404, "Original legacy Feishu provider is unavailable")
	}
	if action == "reply" {
		if strings.TrimSpace(text) == "" {
			return nil, httpx.Fail(400, "Invalid text")
		}
		digestBytes := sha256.Sum256([]byte(id + "\n" + text))
		digest := hex.EncodeToString(digestBytes[:])
		for _, previous := range listMaps(delivery["replies"]) {
			if previous["digest"] == digest {
				return map[string]any{"status": "replied", "message_id": id, "reply_id": previous["message_id"]}, nil
			}
		}
	}
	if str(delivery["acknowledged_at"]) == "" {
		delivery["acknowledged_at"] = time.Now().UTC().Format(time.RFC3339Nano)
		if err = s.options.Store.Put("lark_deliveries", id, delivery); err != nil {
			return nil, err
		}
		s.report(map[string]any{"source": "lark", "status": "session_acknowledged", "message_id": id, "chat_id": delivery["chat_id"], "session_id": delivery["session_id"]})
	}
	if action == "ack" {
		return map[string]any{"status": "session_acknowledged", "message_id": id, "acknowledged_at": delivery["acknowledged_at"]}, nil
	}
	digestBytes := sha256.Sum256([]byte(id + "\n" + text))
	digest := hex.EncodeToString(digestBytes[:])
	content, _ := json.Marshal(map[string]string{"text": "[" + str(delivery["session_name"]) + "] " + text})
	tokenResult, err := s.legacyRequest(ctx, "/open-apis/auth/v3/tenant_access_token/internal", "", map[string]any{"app_id": credentials["appId"], "app_secret": credentials["appSecret"]})
	if err != nil {
		return nil, err
	}
	token := str(tokenResult["tenant_access_token"])
	if token == "" {
		return nil, errors.New("Feishu did not return an application token")
	}
	result, err := s.legacyRequest(ctx, "/open-apis/im/v1/messages/"+url.PathEscape(id)+"/reply", token, map[string]any{"msg_type": "text", "content": string(content), "reply_in_thread": str(delivery["thread_id"]) != "", "uuid": digest[:40]})
	if err != nil {
		return nil, err
	}
	data := asMap(result["data"])
	replyID := str(data["message_id"])
	if replyID == "" || data["chat_id"] != delivery["chat_id"] {
		return nil, errors.New("Feishu returned an unexpected reply destination")
	}
	replies := listMaps(delivery["replies"])
	replies = append(replies, map[string]any{"digest": digest, "message_id": replyID, "time": time.Now().UTC().Format(time.RFC3339Nano)})
	if len(replies) > 20 {
		replies = replies[len(replies)-20:]
	}
	delivery["replies"] = replies
	if err = s.options.Store.Put("lark_deliveries", id, delivery); err != nil {
		return nil, err
	}
	s.report(map[string]any{"source": "lark", "status": "replied", "message_id": id, "reply_id": replyID, "chat_id": delivery["chat_id"], "session_id": delivery["session_id"], "preview": text})
	return map[string]any{"status": "replied", "message_id": id, "reply_id": replyID}, nil
}
func (s *Service) legacyRequest(ctx context.Context, path, token string, body any) (map[string]any, error) {
	base := s.options.APIBaseURL
	if base == "" {
		base = "https://open.feishu.cn"
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}
	client := s.options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := copyClient.Do(request)
	if err != nil {
		return nil, errors.New("Feishu request failed")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 {
		return nil, errors.New("Invalid Feishu response")
	}
	var result map[string]any
	if json.Unmarshal(data, &result) != nil {
		return nil, errors.New("Invalid Feishu response")
	}
	code, _ := result["code"].(float64)
	if response.StatusCode < 200 || response.StatusCode >= 300 || code != 0 {
		return nil, fmt.Errorf("Feishu request returned HTTP %d, code %.0f", response.StatusCode, code)
	}
	return result, nil
}
