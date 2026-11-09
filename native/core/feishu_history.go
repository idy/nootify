package main

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"time"

	im "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func feishuCursorKey(app, chat string) string {
	raw, _ := json.Marshal([]string{app, chat})
	return string(raw)
}

// A source ID cannot expire while a future retry of unresolved history could
// encounter it. Relay retention has separate inbox and peer obligations.
func feishuHistoryUnresolved(d *State, record EventRecord) bool {
	e := record.Event
	if record.Outcome == "deleted" || e.Message.OriginNodeID != d.NodeID || e.ChatID == "" || e.SourceCreatedAt == 0 {
		return false
	}
	cfg := d.Providers[e.Message.ProviderID]
	if cfg.Type != "feishu" {
		return false
	}
	cursor, exists := d.FeishuCursors[feishuCursorKey(cfg.AppID, e.ChatID)]
	return exists && e.SourceCreatedAt > cursor
}

func (p *feishuProvider) historyBindings() []Binding {
	d := p.core.store.Snapshot()
	resources := []Binding{}
	seen := map[string]bool{}
	for _, binding := range d.Bindings {
		for _, resource := range bindingResources(binding) {
			cfg := d.Providers[resource.ProviderID]
			if resource.Deleted || resource.ChatID == "" || cfg.Type != "feishu" || cfg.AppID != p.config.AppID || seen[resource.ChatID] {
				continue
			}
			seen[resource.ChatID] = true
			resources = append(resources, resource)
		}
	}
	return resources
}

func (p *feishuProvider) connectionLost() {
	p.mu.Lock()
	// A reconnect callback may lag the actual socket loss. Keep the last
	// proven connected boundary rather than skipping that unobserved interval.
	p.connected = false
	p.historyGeneration++
	if p.historyCancel != nil {
		p.historyCancel()
	}
	for chat, coverage := range p.coverage {
		coverage.cancel()
		delete(p.coverage, chat)
	}
	p.mu.Unlock()
	p.core.setStatus(p.config.ID, "reconnecting")
}

func (p *feishuProvider) connectionReady() {
	p.mu.Lock()
	if p.connected || p.ctx.Err() != nil {
		p.mu.Unlock()
		return
	}
	p.connected, p.recovering = true, true
	p.historyGeneration++
	generation := p.historyGeneration
	ctx, cancel := context.WithCancel(p.ctx)
	p.historyCancel = cancel
	p.historyWG.Add(1)
	end := time.Now().UnixMilli()
	resources := p.historyBindings()
	p.mu.Unlock()
	p.core.setStatus(p.config.ID, "connected")
	go func() {
		defer p.historyWG.Done()
		defer cancel()
		backoff := 250 * time.Millisecond
		for {
			attempt, stop := context.WithTimeout(ctx, 45*time.Second)
			err := p.reconcileResources(attempt, end, resources)
			stop()
			p.mu.Lock()
			current := generation == p.historyGeneration && p.connected && ctx.Err() == nil
			if current && err == nil {
				p.recovering = false
			}
			p.mu.Unlock()
			if err == nil || !current {
				return
			}
			p.core.log("feishu_history_reconciliation_failed", p.config.ID, "")
			// Retry only this captured offline interval, never a moving live
			// range. Once synchronized, no timer or history request remains.
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			backoff = min(backoff*2, 30*time.Second)
		}
	}()
}

// Reconcile one finite startup/reconnection interval. The cursor moves only
// after every history page is ingested durably; uncertain deliveries stay
// deduplicated in Core.Ingest, while proven retryable outcomes may retry safely.
func (p *feishuProvider) reconcileHistory(ctx context.Context, end int64) error {
	return p.reconcileResources(ctx, end, p.historyBindings())
}

func (p *feishuProvider) reconcileResources(ctx context.Context, end int64, resources []Binding) error {
	for _, resource := range resources {
		key := feishuCursorKey(p.config.AppID, resource.ChatID)
		cursor := p.core.store.Snapshot().FeishuCursors[key]
		if cursor >= end {
			continue
		} // Another proven finite scan already covered it.
		if cursor != 0 && cursor < end {
			if err := p.reconcileChat(ctx, resource.ChatID, cursor, end); err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := p.core.store.Update(func(d *State) error {
			if d.FeishuCursors[key] < end {
				d.FeishuCursors[key] = end
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

type feishuHistoryMessage struct {
	MessageID  string `json:"message_id"`
	ChatID     string `json:"chat_id"`
	ThreadID   string `json:"thread_id"`
	CreateTime string `json:"create_time"`
	Kind       string `json:"msg_type"`
	Deleted    bool   `json:"deleted"`
	Body       struct {
		Content string `json:"content"`
	} `json:"body"`
	Sender struct {
		ID     string `json:"id"`
		IDType string `json:"id_type"`
		Type   string `json:"sender_type"`
	} `json:"sender"`
}

func (p *feishuProvider) reconcileChat(ctx context.Context, chat string, start, end int64) error {
	tokens := map[string]bool{}
	pageToken := ""
	for pageNumber := 0; pageNumber < 1000; pageNumber++ {
		query := url.Values{
			"container_id_type": {"chat"}, "container_id": {chat}, "page_size": {"50"},
			"sort_type": {"ByCreateTimeAsc"}, "only_thread_root_messages": {"false"},
			"start_time": {strconv.FormatInt(start/1000, 10)},
			"end_time":   {strconv.FormatInt(end/1000+1, 10)},
		}
		if pageToken != "" {
			query.Set("page_token", pageToken)
		}
		var page struct {
			Items     []feishuHistoryMessage `json:"items"`
			HasMore   *bool                  `json:"has_more"`
			PageToken string                 `json:"page_token"`
		}
		if err := p.api(ctx, "GET", "/open-apis/im/v1/messages?"+query.Encode(), nil, &page); err != nil {
			return err
		}
		if page.HasMore == nil || (*page.HasMore && page.Items == nil) {
			return fault("unavailable", "invalid Feishu history page")
		}
		for _, item := range page.Items {
			created, err := strconv.ParseInt(item.CreateTime, 10, 64)
			if err != nil || created < 0 || item.MessageID == "" || item.ChatID != chat {
				return fault("unavailable", "invalid Feishu history message")
			}
			if created <= start || created > end || item.Deleted || item.Sender.Type != "user" || item.Sender.IDType != "open_id" {
				continue
			}
			kind, content, sender, id, thread := item.Kind, item.Body.Content, item.Sender.ID, item.MessageID, item.ThreadID
			payload := &im.P2MessageReceiveV1{Event: &im.P2MessageReceiveV1Data{
				Sender:  &im.EventSender{SenderType: &item.Sender.Type, SenderId: &im.UserId{OpenId: &sender}},
				Message: &im.EventMessage{MessageId: &id, ChatId: &chat, ThreadId: &thread, MessageType: &kind, Content: &content, CreateTime: &item.CreateTime},
			}}
			if err := p.receive(context.WithValue(ctx, historyReplayKey{}, true), payload); err != nil {
				return err
			}
		}
		if !*page.HasMore {
			return nil
		}
		if page.PageToken == "" || tokens[page.PageToken] {
			return fault("unavailable", "invalid Feishu history pagination")
		}
		tokens[page.PageToken] = true
		pageToken = page.PageToken
	}
	return fault("resource_exhausted", "Feishu history interval exceeds page limit")
}
