package settings

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/boombuler/barcode"
	"github.com/boombuler/barcode/qr"
)

var appPattern = regexp.MustCompile(`(?i)^cli_[0-9a-f]{16}$`)
var openPattern = regexp.MustCompile(`^ou_[A-Za-z0-9]+$`)
var contactPattern = regexp.MustCompile(`^contact:[a-z0-9_.]+(?::[a-z0-9_.]+)?$`)
var messagingPattern = regexp.MustCompile(`^im:[a-z0-9_.]+(?::[a-z0-9_.]+)?$`)
var contactSearch = regexp.MustCompile(`\bcontact:[a-z0-9_.]+(?::[a-z0-9_.]+)?\b`)
var consoleSearch = regexp.MustCompile(`https://open\.feishu\.cn/app/[^\s<>"']+`)

type Permission struct {
	Scopes []string `json:"scopes"`
	URL    string   `json:"url,omitempty"`
	QR     string   `json:"qr,omitempty"`
}
type Error struct {
	Status     int         `json:"status"`
	Message    string      `json:"error"`
	Code       string      `json:"code,omitempty"`
	Permission *Permission `json:"permission,omitempty"`
}

func (e *Error) Error() string                  { return e.Message }
func problem(status int, message string) *Error { return &Error{Status: status, Message: message} }

type apiError struct {
	code       int
	permission *Permission
}

func (e *apiError) Error() string { return fmt.Sprintf("Feishu API %d: request failed", e.code) }
func permissionCode(code int) bool {
	switch code {
	case 99991672, 99991679, 99991668, 40004, 41050:
		return true
	}
	return false
}
func consoleURL(raw, app string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.Host == "open.feishu.cn" && u.User == nil && u.Path == "/app/"+app+"/auth"
}
func permissionDetails(body map[string]any, app string) *Permission {
	if !permissionCode(int(number(body["code"]))) {
		return nil
	}
	p := &Permission{Scopes: []string{}}
	seen := map[string]bool{}
	add := func(s string) {
		if contactPattern.MatchString(s) && !seen[s] {
			seen[s] = true
			p.Scopes = append(p.Scopes, s)
		}
	}
	for _, s := range contactSearch.FindAllString(text(body["msg"]), -1) {
		add(s)
	}
	candidates := []string{text(body["console_url"])}
	details := object(body["error"])
	candidates = append(candidates, text(details["console_url"]))
	for _, v := range array(details["permission_violations"]) {
		m := object(v)
		add(text(m["scope"]))
		add(text(m["subject"]))
	}
	for _, v := range array(details["helps"]) {
		candidates = append(candidates, text(object(v)["url"]))
	}
	candidates = append(candidates, consoleSearch.FindAllString(text(body["msg"]), -1)...)
	for _, s := range candidates {
		if consoleURL(s, app) {
			p.URL = s
			break
		}
	}
	return p
}
func makeQR(target string, size int) (string, error) {
	code, e := qr.Encode(target, qr.M, qr.Auto)
	if e != nil {
		return "", e
	}
	// A three-module quiet zone is rendered locally; no registration or permission URL leaves this process.
	side := code.Bounds().Dx()
	scale := (size) / (side + 6)
	if scale < 1 {
		scale = 1
	}
	scaled, e := barcode.Scale(code, side*scale, side*scale)
	if e != nil {
		return "", e
	}
	img := image.NewGray(image.Rect(0, 0, size, size))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	offset := (size - scaled.Bounds().Dx()) / 2
	for y := 0; y < scaled.Bounds().Dy(); y++ {
		for x := 0; x < scaled.Bounds().Dx(); x++ {
			img.Set(x+offset, y+offset, scaled.At(x, y))
		}
	}
	var b bytes.Buffer
	if e = png.Encode(&b, img); e != nil {
		return "", e
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b.Bytes()), nil
}
func (s *Service) permissionHelp(app string, p *Permission, messaging bool) (*Permission, error) {
	allowed := contactPattern
	if messaging {
		allowed = messagingPattern
	}
	if p == nil {
		p = &Permission{Scopes: []string{"contact:contact.base:readonly", "contact:user.base:readonly"}}
	}
	r := &Permission{Scopes: []string{}}
	seen := map[string]bool{}
	for _, scope := range p.Scopes {
		if allowed.MatchString(scope) && !seen[scope] && len(r.Scopes) < 100 {
			seen[scope] = true
			r.Scopes = append(r.Scopes, scope)
		}
	}
	if consoleURL(p.URL, app) {
		r.URL = p.URL
	} else {
		r.URL = "https://open.feishu.cn/app"
		if appPattern.MatchString(app) {
			u, _ := url.Parse(r.URL + "/" + app + "/auth")
			if len(r.Scopes) > 0 {
				q := u.Query()
				q.Set("q", strings.Join(r.Scopes, ","))
				q.Set("op_from", "openapi")
				u.RawQuery = q.Encode()
			}
			r.URL = u.String()
		}
	}
	var e error
	r.QR, e = s.qr(r.URL, 184)
	return r, e
}

type larkAPI struct {
	service     *Service
	credentials Credentials
	tokenGate   chan struct{}
	token       string
	expires     time.Time
}

func (s *Service) api(c Credentials) *larkAPI {
	s.apiMu.Lock()
	defer s.apiMu.Unlock()
	if s.currentAPI == nil || s.currentAPI.credentials != c {
		s.currentAPI = &larkAPI{service: s, credentials: c, tokenGate: make(chan struct{}, 1)}
	}
	return s.currentAPI
}
func (a *larkAPI) request(ctx context.Context, path string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	token, e := a.accessToken(ctx)
	if e != nil {
		return nil, e
	}
	body, e := a.service.requestJSON(ctx, http.MethodGet, a.service.apiBase+path, nil, "Bearer "+token)
	if e != nil {
		return nil, e
	}
	if code := int(number(body["code"])); code != 0 {
		return nil, &apiError{code, permissionDetails(body, a.credentials.AppID)}
	}
	data := object(body["data"])
	if data == nil {
		data = map[string]any{}
	}
	return data, nil
}
func (a *larkAPI) accessToken(ctx context.Context) (string, error) {
	select {
	case a.tokenGate <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-a.tokenGate }()
	if a.token != "" && time.Now().Before(a.expires) {
		return a.token, nil
	}
	body, e := a.service.token(ctx, a.credentials)
	if e != nil {
		return "", e
	}
	a.token = text(body["tenant_access_token"])
	if a.token == "" {
		return "", errors.New("Feishu returned no tenant access token")
	}
	a.expires = time.Now().Add(time.Duration(max(1, number(body["expire"])-60)) * time.Second)
	return a.token, nil
}
func (s *Service) token(ctx context.Context, c Credentials) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	b, _ := json.Marshal(c)
	body, e := s.requestJSON(ctx, http.MethodPost, s.apiBase+"/open-apis/auth/v3/tenant_access_token/internal", bytes.NewReader(b), "")
	if e != nil {
		return nil, e
	}
	if code := int(number(body["code"])); code != 0 {
		return nil, &apiError{code, nil}
	}
	if trim(text(body["tenant_access_token"])) == "" {
		return nil, errors.New("Feishu returned no tenant access token")
	}
	return body, nil
}
func (s *Service) verify(ctx context.Context, c Credentials) error {
	if s.options.Verify != nil {
		return s.options.Verify(ctx, c)
	}
	_, e := s.token(ctx, c)
	return e
}
func (s *Service) requestJSON(ctx context.Context, method, target string, body io.Reader, authorization string) (map[string]any, error) {
	req, e := http.NewRequestWithContext(ctx, method, target, body)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	r, e := s.client.Do(req)
	if e != nil {
		return nil, e
	}
	defer r.Body.Close()
	b, e := io.ReadAll(io.LimitReader(r.Body, 8*1024*1024+1))
	if e != nil {
		return nil, e
	}
	if len(b) > 8*1024*1024 {
		return nil, errors.New("oversized Feishu response")
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil || out == nil {
		return nil, errors.New("invalid Feishu response")
	}
	if _, ok := out["code"].(float64); !ok {
		return nil, errors.New("invalid Feishu response code")
	}
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		if number(out["code"]) == 0 {
			return nil, errors.New("Feishu request failed")
		}
	}
	return out, nil
}
func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func array(v any) []any           { a, _ := v.([]any); return a }
func text(v any) string           { s, _ := v.(string); return s }
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
func jsonObject(v any) (map[string]any, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return nil, e
	}
	var m map[string]any
	e = json.Unmarshal(b, &m)
	return m, e
}
