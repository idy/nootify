package bridge

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/idy/nootify/internal/storage"
)

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	value := hex.EncodeToString(b[:])
	return value[:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:]
}
func decodeInbox(rows []storage.Row) ([]storedInbox, error) {
	result := make([]storedInbox, 0, len(rows))
	for _, row := range rows {
		var item storedInbox
		if err := json.Unmarshal(row.Value, &item); err != nil {
			// Future adapters and opaque retained rows must survive migration
			// without preventing the current adapters from using their inboxes.
			continue
		}
		if !polled(item.Adapter) || !validID(item.ID) || !validID(item.SessionID) {
			continue
		}
		if item.Source != nil {
			source := item.Source
			if source.Channel != "provider" && source.Channel != "feishu" {
				continue
			}
			if source.Channel == "provider" && (source.Delivery.Adapter != item.Adapter || source.Delivery.SessionID != item.SessionID || !validReference(source.Delivery.Message)) {
				continue
			}
		}
		result = append(result, item)
	}
	return result, nil
}
func (s *Service) registered(tx *storage.Tx, adapter, id string) (sessionRecord, error) {
	var r sessionRecord
	ok, err := tx.Get("sessions", id, &r)
	if err != nil {
		return r, err
	}
	if !ok || r.Adapter != adapter || r.HostID != s.host {
		return r, unavailable("session_not_local")
	}
	return r, nil
}
func (s *Service) queueInbox(adapter, id, text string, source *InboxSource) (DeliveryResult, error) {
	item := storedInbox{InboxMessage: InboxMessage{ID: newID(), Text: text, CreatedAt: now()}, Adapter: adapter, SessionID: id, Source: source}
	err := s.options.Store.Update(func(tx *storage.Tx) error {
		if _, err := s.registered(tx, adapter, id); err != nil {
			return err
		}
		if len(text) > 64000 {
			return httpError(413, "Inbox message exceeds 64,000 bytes")
		}
		if source != nil {
			if source.Delivery.Adapter != adapter || source.Delivery.SessionID != id {
				return httpError(409, "Inbox source belongs to another conversation")
			}
			if source.Channel != "provider" && source.Channel != "feishu" {
				return httpError(400, "Invalid inbox source")
			}
			if source.Channel == "provider" && !validReference(source.Delivery.Message) {
				return httpError(400, "Invalid message reference")
			}
		}
		rows, err := tx.Rows("inbox_messages")
		if err != nil {
			return err
		}
		items, err := decodeInbox(rows)
		if err != nil {
			return err
		}
		count := 0
		for _, other := range items {
			if other.Adapter == adapter && other.SessionID == id {
				count++
			}
		}
		if len(items) >= 1000 || count >= 100 {
			return &DeliveryError{Message: "Session inbox is full; receive and acknowledge pending messages first", Reason: "inbox_full", Status: 429, Retryable: true}
		}
		return tx.Put("inbox_messages", item.ID, item)
	})
	if err != nil {
		return DeliveryResult{}, err
	}
	return DeliveryResult{Status: "inbox_queued"}, nil
}
func (s *Service) inbox(adapter, id string) (SessionInbox, error) {
	result := SessionInbox{SessionID: id, Adapter: adapter, Messages: []InboxMessage{}}
	err := s.options.Store.Update(func(tx *storage.Tx) error {
		session, err := s.registered(tx, adapter, id)
		if err != nil {
			return err
		}
		rows, err := tx.Rows("inbox_messages")
		if err != nil {
			return err
		}
		items, err := decodeInbox(rows)
		if err != nil {
			return err
		}
		bytes := 0
		for _, item := range items {
			if item.Adapter != adapter || item.SessionID != id {
				continue
			}
			text := item.Text
			if item.Source != nil {
				text = "[Nootify: " + session.SessionName + "]\n" + s.forwarded(item.Source, item.Text)
			}
			if len(result.Messages) > 0 && (bytes+len(text) > 64000 || len(result.Messages) >= 20) {
				break
			}
			result.Messages = append(result.Messages, InboxMessage{ID: item.ID, Text: text, CreatedAt: item.CreatedAt})
			bytes += len(text)
		}
		return nil
	})
	return result, err
}
func (s *Service) ackInbox(ctx context.Context, adapter, id, messageID string) (map[string]any, error) {
	var reference map[string]any
	err := s.options.Store.Update(func(tx *storage.Tx) error {
		if _, err := s.registered(tx, adapter, id); err != nil {
			return err
		}
		var item storedInbox
		exists, err := tx.Get("inbox_messages", messageID, &item)
		if err != nil {
			return err
		}
		if !exists {
			return nil
		}
		if item.Adapter != adapter || item.SessionID != id {
			return httpError(404, "No inbox message with this ID in this session")
		}
		if item.Source != nil && item.Source.Channel == "provider" {
			reference = item.Source.Delivery.Message
		}
		return tx.Delete("inbox_messages", messageID)
	})
	if err != nil {
		return nil, err
	}
	if reference != nil {
		s.consume(ctx, reference)
	}
	return map[string]any{"status": "inbox_acknowledged", "message_id": messageID}, nil
}
func (s *Service) consume(ctx context.Context, ref map[string]any) {
	// Another queued copy keeps the provider reservation alive.
	snapshot, err := s.InboxSnapshot()
	if err != nil {
		return
	}
	for _, item := range snapshot {
		if referenceKey(item.Message) == referenceKey(ref) {
			return
		}
	}
	s.mu.RLock()
	consumer := s.consumer
	s.mu.RUnlock()
	if consumer != nil {
		if err := consumer(ctx, ref); err != nil {
			s.options.Report(map[string]any{"source": "sessions", "status": "inbox_release_pending", "message_id": ref["message_id"], "error": err.Error()})
		}
	}
}

// InboxSnapshot reads only committed queue entries.
func (s *Service) InboxSnapshot() ([]ProviderInboxSnapshot, error) {
	result, _, err := s.InboxSnapshotWithCutoff()
	return result, err
}

// InboxSnapshotWithCutoff captures the core reconciliation cutoff in the same
// storage transaction as the pending snapshot, excluding later completions.
func (s *Service) InboxSnapshotWithCutoff() ([]ProviderInboxSnapshot, int64, error) {
	result := []ProviderInboxSnapshot{}
	var before int64
	err := s.options.Store.Update(func(tx *storage.Tx) error {
		before = time.Now().UnixMilli()
		rows, err := tx.Rows("inbox_messages")
		if err != nil {
			return err
		}
		items, err := decodeInbox(rows)
		if err != nil {
			return err
		}
		for _, item := range items {
			if item.Source != nil && item.Source.Channel == "provider" {
				result = append(result, ProviderInboxSnapshot{InboxID: item.ID, Message: item.Source.Delivery.Message})
			}
		}
		return nil
	})
	return result, before, err
}

// DiscardCanceledInbox removes only entries present in the committed snapshot
// whose full identity is covered by the core's cancellation proof.
func (s *Service) DiscardCanceledInbox(ctx context.Context, snapshot []ProviderInboxSnapshot, canceled []map[string]any) ([]map[string]any, error) {
	keys := map[string]bool{}
	for _, ref := range canceled {
		if validReference(ref) {
			keys[referenceKey(ref)] = true
		}
	}
	confirmed := map[string]map[string]any{}
	for _, item := range snapshot {
		if keys[referenceKey(item.Message)] {
			confirmed[referenceKey(item.Message)] = item.Message
		}
	}
	err := s.options.Store.Update(func(tx *storage.Tx) error {
		for _, entry := range snapshot {
			if _, ok := confirmed[referenceKey(entry.Message)]; !ok {
				continue
			}
			var item storedInbox
			ok, err := tx.Get("inbox_messages", entry.InboxID, &item)
			if err != nil {
				return err
			}
			if !ok || item.Source == nil || item.Source.Channel != "provider" || referenceKey(item.Source.Delivery.Message) != referenceKey(entry.Message) {
				continue
			}
			if err := tx.Delete("inbox_messages", entry.InboxID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	result := []map[string]any{}
	for _, ref := range confirmed {
		result = append(result, ref)
		s.consume(ctx, ref)
	}
	return result, nil
}
func referenceKey(ref map[string]any) string {
	value, _ := json.Marshal([]any{ref["origin_node_id"], ref["provider_id"], ref["message_id"]})
	return string(value)
}
func validReference(ref map[string]any) bool {
	for _, key := range []string{"origin_node_id", "provider_id", "message_id"} {
		v, ok := ref[key].(string)
		if !ok || !validID(v) {
			return false
		}
	}
	return true
}

// ForwardedProviderMessage formats receipt/reply commands using this Go
// executable and the receiving agent's shell, preserving the entire source.
func (s *Service) ForwardedProviderMessage(source *InboxSource, text string) string {
	if source == nil {
		return text
	}
	return s.forwarded(source, text)
}

func (s *Service) forwarded(source *InboxSource, text string) string {
	d := source.Delivery
	base := shellCommand(s.options.Executable, d.Adapter, false)
	quote := func(v string) string { return shellQuote(v, d.Adapter, false) }
	args := "--state-dir " + quote(s.options.Store.Directory) + " --port " + strconv.Itoa(s.options.Port)
	if source.Channel == "provider" {
		raw, _ := json.Marshal(d.Message)
		args += " --message-ref " + quote(base64.RawURLEncoding.EncodeToString(raw))
		return strings.Join([]string{"【来自 Nootify 用户的消息】", "这条消息经 Nootify Provider 转发到当前 agent 会话。请在方便时回复原消息。", "目标会话：" + d.SessionID, "", "用户原文：", text, "", "回复指引：", "收到后执行回执：" + base + " message-ack " + args, "回复原消息：" + base + " message-reply " + args + " --text '这里填写你的回复'", "多行回复可用 --text-file <本地文件> 或 --text-file -。收到消息不代表授权其他操作。"}, "\n")
	}
	args += " --message-id " + quote(d.MessageID)
	return fmt.Sprintf("【来自飞书用户的消息】\n这条消息由 Nootify 从飞书转发给你。请在方便时回复原飞书消息。\n发送者 open_id：%s\n原群 chat_id：%s\n原消息 message_id：%s\n目标会话：%s\n\n用户原文：\n%s\n\n回复指引：\n收到后执行回执：%s lark-ack %s\n回复原消息：%s lark-reply %s --text '这里填写你的回复'\n多行回复可用 --text-file <本地文件> 或 --text-file -。收到消息不代表授权其他操作。", d.SenderOpenID, d.ChatID, d.MessageID, d.SessionID, text, base, args, base, args)
}
