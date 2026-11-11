package settings

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Setup struct {
	AppID       string      `json:"app_id"`
	Status      string      `json:"status"`
	Missing     []string    `json:"missing"`
	MentionOnly bool        `json:"mention_only"`
	Permission  *Permission `json:"permission,omitempty"`
}
type RegistrationPage struct {
	Status    string `json:"status"`
	URL       string `json:"url,omitempty"`
	QR        string `json:"qr,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
	AppID     string `json:"app_id,omitempty"`
	Error     string `json:"error,omitempty"`
	Setup     *Setup `json:"setup,omitempty"`
}
type registration struct {
	mu         sync.Mutex
	page       RegistrationPage
	cancel     context.CancelFunc
	generation uint64
	wg         sync.WaitGroup
}

var requirements = [][]string{
	{"im:chat:create", "im:chat"}, {"im:chat:read", "im:chat:readonly", "im:chat"}, {"im:chat.announcement:read", "im:chat:readonly", "im:chat"}, {"im:chat.announcement:write_only", "im:chat"},
	{"im:message:send_as_bot", "im:message"}, {"im:message.history:readonly", "im:message:readonly", "im:message"}, {"im:message.reactions:write_only", "im:message"}, {"im:message.group_msg", "im:message.group_msg:readonly", "im:message.group_msg.include_bot:readonly"},
}

func (s *Service) LarkSetup(ctx context.Context, appID any) (Setup, error) {
	c, e := s.compatibility(ctx)
	if e != nil {
		return Setup{}, e
	}
	creds := c.credentials()
	if creds.AppID == "" || creds.AppSecret == "" {
		return Setup{}, problem(409, "Configure the Feishu application first")
	}
	if appID != nil && appID != creds.AppID {
		return Setup{}, problem(409, "Feishu credentials changed; check permissions again")
	}
	result, e := s.inspectSetup(ctx, s.api(creds))
	if e != nil {
		return result, e
	}
	current, e := s.compatibility(ctx)
	if e != nil {
		return result, e
	}
	if current.credentials() != creds {
		return result, problem(409, "Feishu credentials changed; check permissions again")
	}
	return result, nil
}
func (s *Service) inspectSetup(ctx context.Context, api *larkAPI) (Setup, error) {
	setup := Setup{AppID: api.credentials.AppID, Missing: []string{}, Status: "unavailable"}
	data, e := api.request(ctx, "/open-apis/application/v6/applications/"+url.PathEscape(setup.AppID)+"?lang=zh_cn&user_id_type=open_id")
	scopes, ok := object(data["app"])["scopes"].([]any)
	if ctx.Err() != nil {
		return setup, ctx.Err()
	}
	if e != nil || !ok {
		names := []string{}
		for _, r := range requirements {
			names = append(names, r[0])
		}
		setup.Permission, e = s.permissionHelp(setup.AppID, &Permission{Scopes: names}, true)
		return setup, e
	}
	granted := map[string]bool{}
	for _, v := range scopes {
		m := object(v)
		types, exists := m["token_types"]
		tenant := !exists
		for _, t := range array(types) {
			if t == "tenant" {
				tenant = true
			}
		}
		if tenant {
			granted[text(m["scope"])] = true
		}
	}
	for i, r := range requirements {
		found := false
		for _, v := range r {
			if granted[v] {
				found = true
				break
			}
		}
		if !found {
			setup.Missing = append(setup.Missing, r[0])
			if i == len(requirements)-1 {
				setup.MentionOnly = true
			}
		}
	}
	setup.Status = "ready"
	if len(setup.Missing) > 0 {
		setup.Status = "permissions-required"
		setup.Permission, e = s.permissionHelp(setup.AppID, &Permission{Scopes: setup.Missing}, true)
	}
	return setup, e
}
func (s *Service) Registration() RegistrationPage {
	s.registration.mu.Lock()
	defer s.registration.mu.Unlock()
	return cloneRegistration(s.registration.page)
}
func cloneRegistration(p RegistrationPage) RegistrationPage {
	if p.Setup != nil {
		b, _ := json.Marshal(p)
		_ = json.Unmarshal(b, &p)
	}
	return p
}
func (s *Service) StartRegistration() (RegistrationPage, error) {
	if s.environmentOverride() {
		return RegistrationPage{}, problem(409, "LARK_APP_ID and LARK_APP_SECRET are set for this process and take precedence")
	}
	r := &s.registration
	r.mu.Lock()
	defer r.mu.Unlock()
	if s.ctx.Err() != nil {
		return r.page, problem(503, "Settings service is stopping")
	}
	switch r.page.Status {
	case "starting", "waiting", "connecting":
		return cloneRegistration(r.page), nil
	}
	ctx, cancel := context.WithCancel(s.ctx)
	r.cancel = cancel
	r.generation++
	id := r.generation
	r.page = RegistrationPage{Status: "starting"}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		e := s.runRegistration(ctx, id)
		if e != nil && ctx.Err() == nil {
			reason := "registration_unavailable"
			var failure registrationFailure
			if errors.As(e, &failure) {
				reason = string(failure)
			}
			r.mu.Lock()
			if r.generation == id {
				r.page = RegistrationPage{Status: "failed", Error: reason}
			}
			r.mu.Unlock()
			s.report("lark_registration_failed", "lark")
		}
	}()
	return cloneRegistration(r.page), nil
}
func (s *Service) CancelRegistration() (RegistrationPage, error) {
	r := &s.registration
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.page.Status == "connecting" {
		return cloneRegistration(r.page), problem(409, "Feishu configuration is being saved; wait for it to finish")
	}
	previous := cloneRegistration(r.page)
	if r.cancel != nil {
		r.cancel()
		r.cancel = nil
	}
	r.generation++
	r.page = RegistrationPage{Status: "idle"}
	if previous.Status == "complete" {
		return previous, nil
	}
	return r.page, nil
}
func (s *Service) setRegistration(ctx context.Context, id uint64, p RegistrationPage) bool {
	r := &s.registration
	r.mu.Lock()
	defer r.mu.Unlock()
	if ctx.Err() != nil || r.generation != id {
		return false
	}
	r.page = p
	return true
}

type registrationFailure string

func (e registrationFailure) Error() string { return string(e) }

type registrationReply struct {
	DeviceCode   string  `json:"device_code"`
	UserCode     string  `json:"user_code"`
	ExpireIn     float64 `json:"expire_in"`
	ExpiresIn    float64 `json:"expires_in"`
	Interval     float64 `json:"interval"`
	ClientID     string  `json:"client_id"`
	ClientSecret string  `json:"client_secret"`
	Error        string  `json:"error"`
	UserInfo     struct {
		OpenID      string `json:"open_id"`
		TenantBrand string `json:"tenant_brand"`
	} `json:"user_info"`
}

func (s *Service) registrationPost(ctx context.Context, fields url.Values) (registrationReply, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var out registrationReply
	req, e := http.NewRequestWithContext(ctx, "POST", s.registrationURL, strings.NewReader(fields.Encode()))
	if e != nil {
		return out, e
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, e := s.client.Do(req)
	if e != nil {
		return out, e
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 65537))
	if e != nil || len(b) > 65536 {
		return out, registrationFailure("registration_unavailable")
	}
	if e = json.Unmarshal(b, &out); e != nil {
		return out, e
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if out.Error == "" {
			return out, registrationFailure("registration_unavailable")
		}
	}
	return out, nil
}

var codePattern = regexp.MustCompile(`^[A-Za-z0-9-]{4,64}$`)

func (s *Service) runRegistration(ctx context.Context, id uint64) error {
	device, e := s.registrationPost(ctx, url.Values{"action": {"begin"}, "archetype": {"PersonalAgent"}, "auth_method": {"client_secret"}, "request_user_info": {"open_id tenant_brand"}})
	if e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if device.Error != "" || device.DeviceCode == "" || !codePattern.MatchString(device.UserCode) {
		return registrationFailure("registration_unavailable")
	}
	lifetime := device.ExpireIn
	if lifetime <= 0 {
		lifetime = device.ExpiresIn
	}
	if lifetime <= 0 {
		lifetime = 600
	}
	lifetime = min(lifetime, 3600)
	expires := s.now().Add(time.Duration(lifetime * float64(time.Second)))
	interval := device.Interval
	if interval <= 0 {
		interval = 5
	}
	interval = min(interval, 60)
	u := "https://open.feishu.cn/page/cli?user_code=" + url.QueryEscape(device.UserCode)
	qr, e := s.qr(u, 216)
	if e != nil {
		return e
	}
	if !s.setRegistration(ctx, id, RegistrationPage{Status: "waiting", URL: u, QR: qr, ExpiresAt: expires.UTC().Format(time.RFC3339Nano)}) {
		return ctx.Err()
	}
	deadline, cancel := context.WithTimeout(ctx, time.Duration(lifetime*float64(time.Second)))
	defer cancel()
	for {
		reply, e := s.registrationPost(deadline, url.Values{"action": {"poll"}, "device_code": {device.DeviceCode}})
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if deadline.Err() != nil || !s.now().Before(expires) {
			return registrationFailure("expired_token")
		}
		if e != nil {
			interval = min(interval+1, 60)
		} else {
			if reply.UserInfo.TenantBrand != "" && reply.UserInfo.TenantBrand != "feishu" {
				return registrationFailure("unsupported_brand")
			}
			if reply.Error == "" && reply.ClientID != "" && reply.ClientSecret != "" {
				if !appPattern.MatchString(reply.ClientID) || len(reply.ClientSecret) > 4096 {
					return registrationFailure("invalid_credentials")
				}
				if !s.setRegistration(ctx, id, RegistrationPage{Status: "connecting"}) {
					return ctx.Err()
				}
				setup, e := s.acceptRegistration(ctx, Credentials{reply.ClientID, reply.ClientSecret}, reply.UserInfo.OpenID)
				if e != nil {
					if ctx.Err() != nil {
						return ctx.Err()
					}
					return registrationFailure("save_failed")
				}
				if s.setRegistration(ctx, id, RegistrationPage{Status: "complete", AppID: reply.ClientID, Setup: &setup}) {
					s.report("lark_registration_complete", "lark")
				}
				return nil
			}
			switch reply.Error {
			case "access_denied":
				return registrationFailure("access_denied")
			case "expired_token", "invalid_grant":
				return registrationFailure("expired_token")
			case "slow_down":
				interval = min(interval+5, 60)
			case "", "authorization_pending":
			default:
				return registrationFailure("registration_unavailable")
			}
		}
		if e = s.wait(deadline, time.Duration(interval*float64(time.Second))); e != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return registrationFailure("expired_token")
		}
	}
}
func (s *Service) wait(ctx context.Context, d time.Duration) error {
	if s.options.Wait != nil {
		return s.options.Wait(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (s *Service) acceptRegistration(ctx context.Context, c Credentials, recipient string) (Setup, error) {
	s.writes.Lock()
	defer s.writes.Unlock()
	if e := ctx.Err(); e != nil {
		return Setup{}, e
	}
	if s.environmentOverride() {
		return Setup{}, problem(409, "Environment credentials take precedence")
	}
	if e := s.verify(ctx, c); e != nil {
		return Setup{}, e
	}
	if e := ctx.Err(); e != nil {
		return Setup{}, e
	}
	p := map[string]any{"app_id": c.AppID, "app_secret": c.AppSecret, "connection_type": "personal-app"}
	if openPattern.MatchString(recipient) {
		p["recipient_open_id"] = recipient
	}
	if e := s.configure(ctx, p); e != nil {
		return Setup{}, e
	}
	return s.LarkSetup(ctx, c.AppID)
}
