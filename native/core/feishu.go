package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	im "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

type quietLogger struct{}

func (quietLogger) Debug(context.Context, ...interface{}) {}
func (quietLogger) Info(context.Context, ...interface{})  {}
func (quietLogger) Warn(context.Context, ...interface{})  {}
func (quietLogger) Error(context.Context, ...interface{}) {}

type sourceTimeEvidenceKey struct{}
type sourceTimeEvidence struct{ source int64 }
type sourceRecovery struct {
	from    int64
	version uint64
}

type feishuProvider struct {
	mu                sync.Mutex
	receiver          EventHandler
	core              *Core
	config            ProviderConfig
	client            *lark.Client
	ws                *larkws.Client
	ctx               context.Context
	cancel            context.CancelFunc
	connected         bool
	recovering        bool
	historyGeneration uint64
	historyCancel     context.CancelFunc
	historyWG         sync.WaitGroup
	coverage          map[string]*feishuCoverage
	sourceFloor       int64
	recoveryFrom      map[string]sourceRecovery
	recoverySequence  uint64
	initializingChats map[string]bool
}

func newFeishu(c *Core, p ProviderConfig) *feishuProvider {
	ctx, cancel := context.WithCancel(c.ctx)
	return &feishuProvider{core: c, config: p, ctx: ctx, cancel: cancel, client: lark.NewClient(p.AppID, p.AppSecret, lark.WithLogger(quietLogger{}), lark.WithHttpClient(&http.Client{Timeout: 15 * time.Second}))}
}
func (p *feishuProvider) Subscribe(ctx context.Context, receive EventHandler) error {
	if receive == nil {
		return fault("invalid_argument", "event handler is required")
	}
	if err := p.ctx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(p.ctx, cancel)
	defer stop()
	handler := dispatcher.NewEventDispatcher("", "").OnP2MessageReceiveV1(p.receive)
	handler.Config.Logger = quietLogger{}
	ws := larkws.NewClient(p.config.AppID, p.config.AppSecret, larkws.WithLogger(quietLogger{}), larkws.WithEventHandler(handler), larkws.WithOnReady(p.connectionReady), larkws.WithOnReconnecting(p.connectionLost), larkws.WithOnReconnected(p.connectionReady), larkws.WithOnError(func(error) { p.core.setStatus(p.config.ID, "failed") }))
	p.mu.Lock()
	if p.ws != nil {
		p.mu.Unlock()
		return fault("conflict", "bot already has a subscription")
	}
	p.ws = ws
	p.receiver = receive
	p.mu.Unlock()
	err := ws.Start(ctx)
	if err != nil && ctx.Err() == nil {
		p.core.setStatus(p.config.ID, "failed")
	}
	return err
}
func (p *feishuProvider) Close() error {
	p.mu.Lock()
	// Preserve the last accepted boundary: queued socket input may not have
	// reached durable ingestion when the provider is closed.
	p.connected = false
	p.historyGeneration++
	p.cancel()
	ws := p.ws
	p.mu.Unlock()
	p.historyWG.Wait()
	if ws != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := ws.CloseAndWait(ctx)
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	}
	return nil
}
func (p *feishuProvider) api(ctx context.Context, method, path string, body any, out any) error {
	_, err := p.apiSourceTime(ctx, method, path, body, out)
	return err
}

func (p *feishuProvider) apiSourceTime(ctx context.Context, method, path string, body any, out any) (int64, error) {
	u, err := url.Parse(path)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := p.client.Do(ctx, &larkcore.ApiReq{HttpMethod: method, ApiPath: u.Path, QueryParams: larkcore.QueryParams(u.Query()), Body: body, SupportedAccessTokenTypes: []larkcore.AccessTokenType{larkcore.AccessTokenTypeTenant}})
	if err != nil {
		return 0, fault("unavailable", "Feishu request failed")
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err = json.Unmarshal(resp.RawBody, &envelope); err != nil {
		return 0, fault("unavailable", "invalid Feishu response")
	}
	if resp.StatusCode >= 300 || envelope.Code != 0 {
		return 0, &feishuAPIError{Code: envelope.Code, HTTPStatus: resp.StatusCode}
	}
	var source int64
	if date, err := http.ParseTime(resp.Header.Get("Date")); err == nil {
		source = date.UnixMilli()
		if evidence, _ := ctx.Value(sourceTimeEvidenceKey{}).(*sourceTimeEvidence); evidence != nil {
			evidence.source = source
		}
		p.mu.Lock()
		p.sourceFloor = source
		p.mu.Unlock()
	}
	if out != nil && len(envelope.Data) > 0 {
		return source, json.Unmarshal(envelope.Data, out)
	}
	return source, nil
}
func sessionDescription(s Session) string {
	b, _ := json.Marshal(s)
	return "nootify-session:v1:" + base64.RawURLEncoding.EncodeToString(b)
}
func parseSessionDescription(desc string) (Session, error) {
	var s Session
	if !strings.HasPrefix(desc, "nootify-session:v1:") {
		return s, fault("not_found", "group has no session identity")
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(desc, "nootify-session:v1:"))
	if err != nil {
		return s, fault("invalid_argument", "invalid group session identity")
	}
	if err = json.Unmarshal(b, &s); err != nil {
		return s, fault("invalid_argument", "invalid group session identity")
	}
	return s, s.validate()
}
func (p *feishuProvider) Ensure(ctx context.Context, s Session) (Binding, error) {
	if p.config.Recipient == "" {
		return Binding{}, fault("invalid_argument", "a trusted recipient is required")
	}
	description := sessionDescription(s)
	if len(description) > 2048 {
		return Binding{}, fault("invalid_argument", "session metadata is too large for a Feishu group")
	}
	name := s.Name
	if name == "" {
		name = s.SessionID
	}
	runes := []rune(name)
	if len(runes) > 70 {
		name = string(runes[:70])
	}
	identity := s.key() + "\n" + p.config.AppID + "\n" + p.config.Recipient
	if incarnation := resourceIncarnation(p.core.store.Snapshot(), s); incarnation != "" {
		identity += "\n" + incarnation
	}
	hash := sha256.Sum256([]byte(identity))
	var result struct {
		ChatID string `json:"chat_id"`
	}
	startedAt := time.Now() // Monotonic round-trip duration, not a wall-clock boundary.
	source, err := p.apiSourceTime(ctx, "POST", "/open-apis/im/v1/chats?user_id_type=open_id&uuid="+hex.EncodeToString(hash[:16]), map[string]any{"name": name, "description": description, "chat_mode": "group", "chat_type": "private", "user_id_list": []string{p.config.Recipient}}, &result)
	if err != nil {
		return Binding{}, err
	}
	if result.ChatID == "" {
		return Binding{}, fault("unavailable", "Feishu did not return a chat ID")
	}
	started := int64(1)
	if source > 0 {
		started = max(int64(1), source-time.Since(startedAt).Milliseconds()-sourceTimeOverlap)
	}
	return Binding{Session: s, ProviderID: p.config.ID, ChatID: result.ChatID, SenderID: p.config.Recipient, HistoryStart: started}, nil
}
func (p *feishuProvider) Metadata(ctx context.Context, b Binding, m map[string]any, set bool) (map[string]any, error) {
	if !set {
		return b.Session.Metadata, nil
	}
	if legacyBinding(b) {
		return m, nil // Adopted groups keep their existing human description.
	}
	s := b.Session
	s.Metadata = m
	description := sessionDescription(s)
	if len(description) > 2048 {
		return nil, fault("invalid_argument", "session metadata is too large for a Feishu group")
	}
	err := p.api(ctx, "PATCH", "/open-apis/im/v1/chats/"+url.PathEscape(b.ChatID), map[string]any{"description": description}, nil)
	return m, err
}
func (p *feishuProvider) Delete(ctx context.Context, b Binding) error {
	err := p.api(ctx, "DELETE", "/open-apis/im/v1/chats/"+url.PathEscape(b.ChatID), nil, nil)
	var apiErr *feishuAPIError
	if errors.As(err, &apiErr) {
		if apiErr.HTTPStatus == http.StatusNotFound && apiErr.Code == 0 {
			return nil
		}
		// https://open.feishu.cn/document/server-docs/group/chat/delete.md
		// 232009 proves the group is dissolved. 232006 only means an invalid
		// chat_id; permissions and transient/unknown failures prove no absence.
		if (apiErr.HTTPStatus == http.StatusOK || apiErr.HTTPStatus == http.StatusBadRequest) && apiErr.Code == 232009 {
			return nil
		}
	}
	return err
}

// Feishu posts have paragraph rows and native text/link/code nodes. Unsupported
// incoming tags are rejected as a whole, never flattened into misleading text.
func toFeishu(c Content) (string, string, error) {
	if err := c.Validate(); err != nil {
		return "", "", err
	}
	if len(c.Blocks) == 0 {
		b, _ := json.Marshal(map[string]string{"text": c.Text})
		return "text", string(b), nil
	}
	rows := [][]map[string]any{}
	row := []map[string]any{}
	text := func(value string) {
		if value != "" {
			row = append(row, map[string]any{"tag": "text", "text": value})
		}
	}
	finish := func() {
		rows = append(rows, row)
		row = []map[string]any{}
	}
	var nestedText func(ContentBlock) string
	nestedText = func(b ContentBlock) string {
		var value strings.Builder
		value.WriteString(b.Text)
		for _, child := range b.Children {
			value.WriteString(nestedText(child))
			if child.Type == "paragraph" || child.Type == "code" {
				value.WriteByte('\n')
			}
		}
		return value.String()
	}
	var inline func(ContentBlock)
	inline = func(b ContentBlock) {
		switch b.Type {
		case "link":
			label := nestedText(b)
			row = append(row, map[string]any{"tag": "a", "text": label, "href": b.URL})
		case "code":
			row = append(row, map[string]any{"tag": "code_block", "language": "PlainText", "text": nestedText(b)})
			finish()
		default: // Validate already restricted this to paragraph/text.
			text(b.Text)
			for _, child := range b.Children {
				inline(child)
			}
			if b.Type == "paragraph" {
				finish()
			}
		}
	}
	text(c.Text)
	for _, block := range c.Blocks {
		inline(block)
	}
	if len(row) != 0 {
		finish()
	}
	body, _ := json.Marshal(map[string]any{"zh_cn": map[string]any{"title": "", "content": rows}})
	return "post", string(body), nil
}
func fromFeishu(kind, raw string) (Content, error) {
	if len(raw) > maxPayload {
		return Content{}, fault("invalid_argument", "message is too large")
	}
	if kind == "text" {
		var c Content
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			return c, err
		}
		return c, c.Validate()
	}
	if kind != "post" {
		return Content{}, fault("unsupported_content", "unsupported Feishu message type")
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		return Content{}, err
	}
	data := []byte(raw)
	if _, ok := root["content"]; !ok {
		if v, ok := root["zh_cn"]; ok {
			data = v
		} else if v, ok := root["en_us"]; ok {
			data = v
		} else {
			for _, v := range root {
				data = v
				break
			}
		}
	}
	var post struct {
		Title   string `json:"title"`
		Content [][]struct {
			Tag      string `json:"tag"`
			Text     string `json:"text"`
			Href     string `json:"href"`
			Language string `json:"language"`
		} `json:"content"`
	}
	if err := json.Unmarshal(data, &post); err != nil {
		return Content{}, err
	}
	c := Content{}
	if post.Title != "" {
		c.Blocks = append(c.Blocks, ContentBlock{Type: "paragraph", Text: post.Title})
	}
	for _, row := range post.Content {
		paragraph := ContentBlock{Type: "paragraph"}
		// A terminal code block already contributes the row's newline.
		if len(row) != 0 && row[len(row)-1].Tag == "code_block" {
			paragraph.Type = "text"
		}
		for _, n := range row {
			var b ContentBlock
			switch n.Tag {
			case "text":
				b = ContentBlock{Type: "text", Text: n.Text}
			case "a":
				b = ContentBlock{Type: "link", Text: n.Text, URL: n.Href}
			case "code_block":
				b = ContentBlock{Type: "code", Text: n.Text}
			default:
				return Content{}, fault("unsupported_content", "unsupported Feishu post element")
			}
			paragraph.Children = append(paragraph.Children, b)
		}
		c.Blocks = append(c.Blocks, paragraph)
	}
	return c, c.Validate()
}
func (p *feishuProvider) Send(ctx context.Context, b Binding, c Content, request string) (SendResult, error) {
	kind, content, err := toFeishu(c)
	if err != nil {
		return SendResult{}, err
	}
	body := map[string]any{"receive_id": b.ChatID, "msg_type": kind, "content": content}
	if request != "" {
		h := sha256.Sum256([]byte(b.Session.key() + ":" + request))
		body["uuid"] = hex.EncodeToString(h[:16])
	}
	var out struct {
		MessageID string `json:"message_id"`
	}
	if err = p.api(ctx, "POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", body, &out); err != nil {
		return SendResult{}, err
	}
	if out.MessageID == "" {
		return SendResult{}, fault("unavailable", "Feishu did not return a message ID")
	}
	return SendResult{Message: MessageRef{OriginNodeID: p.core.node(), ProviderID: p.config.ID, MessageID: out.MessageID}, MessageID: out.MessageID, ChatID: b.ChatID}, nil
}
func (p *feishuProvider) Reply(ctx context.Context, m MessageRef, c Content, request string) (SendResult, error) {
	kind, content, err := toFeishu(c)
	if err != nil {
		return SendResult{}, err
	}
	body := map[string]any{"msg_type": kind, "content": content, "reply_in_thread": m.ThreadID != ""}
	if request != "" {
		h := sha256.Sum256([]byte(m.key() + ":" + request))
		body["uuid"] = hex.EncodeToString(h[:16])
	}
	var out struct {
		MessageID string `json:"message_id"`
	}
	if err = p.api(ctx, "POST", "/open-apis/im/v1/messages/"+url.PathEscape(m.MessageID)+"/reply", body, &out); err != nil {
		return SendResult{}, err
	}
	if out.MessageID == "" {
		return SendResult{}, fault("unavailable", "Feishu did not return a message ID")
	}
	return SendResult{Message: MessageRef{OriginNodeID: p.core.node(), ProviderID: p.config.ID, MessageID: out.MessageID, ThreadID: m.ThreadID}, MessageID: out.MessageID}, nil
}
func (p *feishuProvider) Ack(ctx context.Context, m MessageRef) error {
	return p.api(ctx, "POST", "/open-apis/im/v1/messages/"+url.PathEscape(m.MessageID)+"/reactions", map[string]any{"reaction_type": map[string]string{"emoji_type": "FINGERHEART"}}, nil)
}
func val(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
func (p *feishuProvider) receive(ctx context.Context, in *im.P2MessageReceiveV1) error {
	if err := p.ctx.Err(); err != nil {
		return err
	}
	if in == nil || in.Event == nil || in.Event.Message == nil || in.Event.Sender == nil {
		return nil
	}
	m := in.Event.Message
	sender := in.Event.Sender
	if val(sender.SenderType) != "user" || sender.SenderId == nil {
		return nil
	}
	if val(m.MessageId) == "" || val(m.ChatId) == "" {
		return nil
	}
	content, err := fromFeishu(val(m.MessageType), val(m.Content))
	if err != nil {
		return nil
	}
	binding, found := p.incomingBinding(val(m.ChatId), val(sender.SenderId.OpenId))
	if !found {
		return nil
	}
	session := binding.Session
	created := int64(0)
	if raw := val(m.CreateTime); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			return nil
		}
		created = parsed
	}
	if !historyReplay(ctx) {
		var recoveryErr error
		if created > 0 {
			p.mu.Lock()
			if p.recoveryFrom == nil {
				p.recoveryFrom = map[string]sourceRecovery{}
			}
			recovery := p.recoveryFrom[binding.ChatID]
			if recovery.from == 0 || created < recovery.from {
				recovery.from = created
			}
			p.recoverySequence++
			recovery.version = p.recoverySequence
			p.recoveryFrom[binding.ChatID] = recovery
			if p.initializingChats[binding.ChatID] {
				key := feishuCursorKey(p.config.AppID, binding.ChatID)
				lower := max(int64(1), recovery.from-sourceTimeOverlap)
				if p.core.store.Snapshot().FeishuCursors[key] > lower {
					// This seed is not proven coverage yet. Publish the observed
					// lower bound before admission can fail without a Store record.
					recoveryErr = p.core.store.Update(func(d *State) error {
						if err := ctx.Err(); err != nil {
							return err
						}
						if d.FeishuCursors[key] > lower {
							d.FeishuCursors[key] = lower
						}
						return nil
					})
				}
			}
			p.mu.Unlock()
		}
		// A failure still leaves outstanding finite recovery work. Its worker
		// belongs to the provider lifetime, not this failed callback's context.
		defer func() {
			// Include the source clock's precision overlap in the query. This
			// lookahead is never itself coverage: the API Date/observed source
			// timestamps cap the boundary actually persisted after the scan.
			end := created + 2*sourceTimeOverlap
			if created == 0 {
				end = 0
			}
			if end == 0 {
				p.mu.Lock()
				end = p.sourceFloor
				p.mu.Unlock()
			}
			if end == 0 {
				end = time.Now().UnixMilli()
			} // Query hint only; never a checkpoint.
			p.scheduleCoverage(binding, end)
		}()
		if recoveryErr != nil {
			return recoveryErr
		}
	}
	if legacyBinding(binding) {
		if err := p.ValidateBinding(ctx, binding); err != nil {
			return err
		}
	}
	ref := MessageRef{OriginNodeID: p.core.node(), ProviderID: p.config.ID, MessageID: val(m.MessageId), ThreadID: val(m.ThreadId)}
	hash := sha256.Sum256([]byte("feishu:" + p.config.AppID + ":" + val(m.MessageId)))
	p.mu.Lock()
	receive := p.receiver
	p.mu.Unlock()
	if receive == nil {
		return fault("unavailable", "bot has no event subscription")
	}
	err = receive(ctx, Event{ID: hex.EncodeToString(hash[:]), Session: session, Message: ref, Content: content, Hops: 16, SenderID: val(sender.SenderId.OpenId), ChatID: val(m.ChatId), SourceCreatedAt: created})
	if err != nil {
		return err
	}
	return nil
}
