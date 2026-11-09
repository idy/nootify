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

type feishuProvider struct {
	mu       sync.Mutex
	receiver EventHandler
	core     *Core
	config   ProviderConfig
	client   *lark.Client
	ws       *larkws.Client
	ctx      context.Context
	cancel   context.CancelFunc
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
	ws := larkws.NewClient(p.config.AppID, p.config.AppSecret, larkws.WithLogger(quietLogger{}), larkws.WithEventHandler(handler), larkws.WithOnReady(func() { p.core.setStatus(p.config.ID, "connected") }), larkws.WithOnReconnecting(func() { p.core.setStatus(p.config.ID, "reconnecting") }), larkws.WithOnReconnected(func() { p.core.setStatus(p.config.ID, "connected") }), larkws.WithOnError(func(error) { p.core.setStatus(p.config.ID, "failed") }))
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
	p.cancel()
	p.mu.Lock()
	ws := p.ws
	p.mu.Unlock()
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
	u, err := url.Parse(path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := p.client.Do(ctx, &larkcore.ApiReq{HttpMethod: method, ApiPath: u.Path, QueryParams: larkcore.QueryParams(u.Query()), Body: body, SupportedAccessTokenTypes: []larkcore.AccessTokenType{larkcore.AccessTokenTypeTenant}})
	if err != nil {
		return fault("unavailable", "Feishu request failed")
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err = json.Unmarshal(resp.RawBody, &envelope); err != nil {
		return fault("unavailable", "invalid Feishu response")
	}
	if resp.StatusCode >= 300 || envelope.Code != 0 {
		return &feishuAPIError{Code: envelope.Code, HTTPStatus: resp.StatusCode}
	}
	if out != nil && len(envelope.Data) > 0 {
		return json.Unmarshal(envelope.Data, out)
	}
	return nil
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
	err := p.api(ctx, "POST", "/open-apis/im/v1/chats?user_id_type=open_id&uuid="+hex.EncodeToString(hash[:16]), map[string]any{"name": name, "description": description, "chat_mode": "group", "chat_type": "private", "user_id_list": []string{p.config.Recipient}}, &result)
	if err != nil {
		return Binding{}, err
	}
	if result.ChatID == "" {
		return Binding{}, fault("unavailable", "Feishu did not return a chat ID")
	}
	return Binding{Session: s, ProviderID: p.config.ID, ChatID: result.ChatID, SenderID: p.config.Recipient}, nil
}
func (p *feishuProvider) Metadata(ctx context.Context, b Binding, m map[string]any, set bool) (map[string]any, error) {
	if !set {
		return b.Session.Metadata, nil
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
	if c.Text != "" {
		rows = append(rows, []map[string]any{{"tag": "text", "text": c.Text}})
	}
	var inline func(ContentBlock) ([]map[string]any, error)
	inline = func(b ContentBlock) ([]map[string]any, error) {
		var out []map[string]any
		switch b.Type {
		case "paragraph":
			if b.Text != "" {
				out = append(out, map[string]any{"tag": "text", "text": b.Text})
			}
		case "text":
			out = append(out, map[string]any{"tag": "text", "text": b.Text})
		case "link":
			text := b.Text
			for _, x := range b.Children {
				text += Content{Blocks: []ContentBlock{x}}.Plain()
			}
			if text == "" {
				text = b.URL
			}
			return []map[string]any{{"tag": "a", "text": text, "href": b.URL}}, nil
		case "code":
			text := b.Text
			for _, x := range b.Children {
				text += Content{Blocks: []ContentBlock{x}}.Plain()
			}
			return []map[string]any{{"tag": "code_block", "language": "PlainText", "text": text}}, nil
		default:
			return nil, fault("unsupported_content", "unsupported Feishu content block")
		}
		for _, child := range b.Children {
			parts, err := inline(child)
			if err != nil {
				return nil, err
			}
			out = append(out, parts...)
		}
		return out, nil
	}
	for _, b := range c.Blocks {
		r, err := inline(b)
		if err != nil {
			return "", "", err
		}
		rows = append(rows, r)
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
	var session Session
	found := false
	allowedSender := ""
	snapshot := p.core.store.Snapshot()
	for _, b := range snapshot.Bindings {
		cfg, ok := snapshot.Providers[b.ProviderID]
		if ok && cfg.Type == "feishu" && cfg.AppID == p.config.AppID && b.ChatID == val(m.ChatId) && !b.Deleted {
			session = b.Session
			allowedSender = b.SenderID
			if allowedSender == "" {
				allowedSender = cfg.Recipient
			}
			found = true
			break
		}
	}
	// Descriptions identify a resource during explicit adoption; they do not
	// authorize ingress. Only a retained binding for this app/chat may route it.
	if !found || allowedSender == "" || val(sender.SenderId.OpenId) != allowedSender {
		return nil
	}
	ref := MessageRef{OriginNodeID: p.core.node(), ProviderID: p.config.ID, MessageID: val(m.MessageId), ThreadID: val(m.ThreadId)}
	hash := sha256.Sum256([]byte("feishu:" + p.config.AppID + ":" + val(m.MessageId)))
	p.mu.Lock()
	receive := p.receiver
	p.mu.Unlock()
	if receive == nil {
		return fault("unavailable", "bot has no event subscription")
	}
	return receive(ctx, Event{ID: hex.EncodeToString(hash[:]), Session: session, Message: ref, Content: content, Hops: 16, SenderID: val(sender.SenderId.OpenId), ChatID: val(m.ChatId)})
}
