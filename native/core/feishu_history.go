package core

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"time"

	im "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

// Date headers have one-second precision. Rescan that source-time bucket and
// retain its source IDs until a later proven boundary covers the overlap.
const sourceTimeOverlap int64 = 1000

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
	return exists && e.SourceCreatedAt >= cursor-sourceTimeOverlap
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
		p.mu.Lock()
		if cursor == 0 {
			if p.initializingChats == nil {
				p.initializingChats = map[string]bool{}
			}
			p.initializingChats[resource.ChatID] = true
		}
		initializing := p.initializingChats[resource.ChatID]
		p.mu.Unlock()
		var seed int64
		if cursor == 0 {
			// Establish only a baseline here. A live callback can fail while this
			// request is in flight, so a successful clock probe is not coverage.
			source, err := p.apiSourceTime(ctx, "GET", "/open-apis/im/v1/chats/"+url.PathEscape(resource.ChatID), nil, nil)
			if err != nil {
				return err
			}
			if source <= sourceTimeOverlap {
				return fault("unavailable", "Feishu source clock is unavailable")
			}
			seed = source - sourceTimeOverlap
		}
		p.mu.Lock()
		recovery := p.recoveryFrom[resource.ChatID]
		p.mu.Unlock()
		if cursor == 0 {
			if recovery.from > 0 {
				seed = min(seed, max(int64(1), recovery.from-sourceTimeOverlap))
			}
			// Published retryable/uncertain admissions survive a restart even if
			// the initial source cursor was never established.
			d := p.core.store.Snapshot()
			for _, delivery := range d.Deliveries {
				if delivery.Status != "retryable" && delivery.Status != "pending" && delivery.Status != "unconfirmed" {
					continue
				}
				event := d.Events[delivery.EventID]
				e := event.Event
				cfg := d.Providers[e.Message.ProviderID]
				if event.Outcome != "deleted" && e.Session.key() == resource.Session.key() && e.ChatID == resource.ChatID && e.Message.OriginNodeID == d.NodeID && cfg.Type == "feishu" && cfg.AppID == p.config.AppID && e.SourceCreatedAt > 0 {
					seed = min(seed, max(int64(1), e.SourceCreatedAt-sourceTimeOverlap))
				}
			}
			if err := p.commitInitialHistorySeed(ctx, key, resource.ChatID, seed); err != nil {
				return err
			}
			cursor = p.core.store.Snapshot().FeishuCursors[key]
		}
		start := max(int64(1), cursor-sourceTimeOverlap)
		if initializing && recovery.from > 0 {
			start = min(start, max(int64(1), recovery.from-sourceTimeOverlap))
		}
		through, err := p.reconcileChat(ctx, resource.ChatID, start, max(end, cursor, recovery.from))
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := p.commitHistoryCoverage(ctx, key, resource.ChatID, through, initializing, recovery); err != nil {
			return err
		}
	}
	return nil
}

// These short disk publications share the observation mutex so a callback
// cannot become known between reading its lower bound and publishing a cursor.
// Store mutations/retention are state-only; no provider lock is acquired there,
// and no Feishu request is made while this mutex is held.
func (p *feishuProvider) commitInitialHistorySeed(ctx context.Context, key, chat string, seed int64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if latest := p.recoveryFrom[chat]; latest.from > 0 {
		seed = min(seed, max(int64(1), latest.from-sourceTimeOverlap))
	}
	return p.core.store.Update(func(d *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.FeishuCursors[key] == 0 {
			d.FeishuCursors[key] = seed
		}
		return nil
	})
}

func (p *feishuProvider) commitHistoryCoverage(ctx context.Context, key, chat string, through int64, initializing bool, scanned sourceRecovery) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	latest := p.recoveryFrom[chat]
	uncovered := initializing && latest.from > 0 && (latest.version != scanned.version || through < latest.from)
	if uncovered {
		through = min(through, max(int64(1), latest.from-sourceTimeOverlap))
	}
	err := p.core.store.Update(func(d *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if uncovered {
			// Only the unproven initialization window may rewind its seed. An
			// established cursor stays monotonic to protect compacted history.
			d.FeishuCursors[key] = through
		} else if d.FeishuCursors[key] < through {
			d.FeishuCursors[key] = through
		}
		return nil
	})
	if err != nil {
		return err
	}
	if scanned.from > 0 && through >= scanned.from && latest.version == scanned.version {
		delete(p.recoveryFrom, chat)
	}
	if initializing && p.recoveryFrom[chat].from == 0 {
		delete(p.initializingChats, chat)
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

func (p *feishuProvider) reconcileChat(ctx context.Context, chat string, start, end int64) (int64, error) {
	proven := int64(0)
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
		source, err := p.apiSourceTime(ctx, "GET", "/open-apis/im/v1/messages?"+query.Encode(), nil, &page)
		if err != nil {
			return 0, err
		}
		if proven == 0 && source > 0 {
			proven = source
		}
		if page.HasMore == nil || (*page.HasMore && page.Items == nil) {
			return 0, fault("unavailable", "invalid Feishu history page")
		}
		for _, item := range page.Items {
			created, err := strconv.ParseInt(item.CreateTime, 10, 64)
			if err != nil || created < 0 || item.MessageID == "" || item.ChatID != chat {
				return 0, fault("unavailable", "invalid Feishu history message")
			}
			proven = max(proven, created)
			if created < start || created > end || item.Deleted || item.Sender.Type != "user" || item.Sender.IDType != "open_id" {
				continue
			}
			kind, content, sender, id, thread := item.Kind, item.Body.Content, item.Sender.ID, item.MessageID, item.ThreadID
			payload := &im.P2MessageReceiveV1{Event: &im.P2MessageReceiveV1Data{
				Sender:  &im.EventSender{SenderType: &item.Sender.Type, SenderId: &im.UserId{OpenId: &sender}},
				Message: &im.EventMessage{MessageId: &id, ChatId: &chat, ThreadId: &thread, MessageType: &kind, Content: &content, CreateTime: &item.CreateTime},
			}}
			if err := p.receive(context.WithValue(ctx, historyReplayKey{}, true), payload); err != nil {
				return 0, err
			}
		}
		if !*page.HasMore {
			if proven == 0 {
				return 0, fault("unavailable", "Feishu source clock is unavailable")
			}
			return min(end, proven), nil
		}
		if page.PageToken == "" || tokens[page.PageToken] {
			return 0, fault("unavailable", "invalid Feishu history pagination")
		}
		tokens[page.PageToken] = true
		pageToken = page.PageToken
	}
	return 0, fault("resource_exhausted", "Feishu history interval exceeds page limit")
}
