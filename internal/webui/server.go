package webui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/idy/nootify/internal/httpx"
)

type connectionKey struct{}
type authenticatedKey struct{}
type challenge struct {
	Client, Nonce, Proof string
	Issued               int64
}
type Owner struct {
	token      string
	sessions   *Sessions
	mu         sync.Mutex
	challenges map[net.Conn]challenge
}

func NewOwner(token string) *Owner {
	return &Owner{token: token, sessions: NewSessions(true), challenges: map[net.Conn]challenge{}}
}
func (o *Owner) ConnContext(ctx context.Context, c net.Conn) context.Context {
	return context.WithValue(ctx, connectionKey{}, c)
}
func (o *Owner) ConnState(c net.Conn, state http.ConnState) {
	if state == http.StateClosed || state == http.StateHijacked {
		o.mu.Lock()
		delete(o.challenges, c)
		o.mu.Unlock()
	}
}
func Authenticated(r *http.Request) bool {
	value, _ := r.Context().Value(authenticatedKey{}).(bool)
	return value
}
func (o *Owner) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ui/api/auth/challenge" || r.URL.Path == "/ui/api/auth/grant" {
			if err := o.bootstrap(w, r); err != nil {
				httpx.WriteError(w, err)
			}
			return
		}
		if r.URL.Path == "/ui/api/secure" {
			serveSecure(o.sessions, w, r, next)
			return
		}
		if equal(r.Header.Get("authorization"), "Bearer "+o.token) {
			r = r.WithContext(context.WithValue(r.Context(), authenticatedKey{}, true))
		}
		next.ServeHTTP(w, r)
	})
}
func (o *Owner) bootstrap(w http.ResponseWriter, r *http.Request) error {
	c, _ := r.Context().Value(connectionKey{}).(net.Conn)
	if c == nil {
		return httpx.Fail(403, "Owner authorization requires the verified connection")
	}
	host := strings.ToLower(r.Host)
	if strings.HasSuffix(r.URL.Path, "/challenge") {
		client := r.URL.Query().Get("nonce")
		if r.Method != "GET" || !noncePattern.MatchString(client) {
			return httpx.Fail(400, "Invalid authorization challenge")
		}
		issued := time.Now().UnixMilli()
		value := challenge{Client: client, Nonce: nonce(24), Issued: issued}
		value.Proof = mac(o.token, "ui-server", host, value.Client, value.Nonce, issued)
		o.mu.Lock()
		o.challenges[c] = value
		o.mu.Unlock()
		httpx.JSON(w, 200, map[string]any{"challenge": value.Nonce, "issued_at": issued, "proof": value.Proof})
		return nil
	}
	if r.Method != "POST" || r.Header.Get("x-nootify-ui") != "1" {
		return httpx.Fail(403, "Owner authorization proof required")
	}
	o.mu.Lock()
	expected, exists := o.challenges[c]
	delete(o.challenges, c)
	o.mu.Unlock()
	value, err := httpx.ReadObject(r, 4096)
	if err != nil {
		return err
	}
	issued, ok := value["issued_at"].(float64)
	if !exists || !ok || int64(issued) != expected.Issued || expected.Issued > time.Now().UnixMilli() || time.Now().UnixMilli()-expected.Issued > 30000 || value["client_nonce"] != expected.Client || value["challenge"] != expected.Nonce || value["server_proof"] != expected.Proof {
		return httpx.Fail(403, "Service owner authorization required on the verified connection")
	}
	proof, _ := value["proof"].(string)
	if !equal(proof, mac(o.token, "ui-client", host, expected.Client, expected.Nonce, expected.Issued, expected.Proof)) {
		return httpx.Fail(403, "Invalid service owner proof")
	}
	capability, err := o.sessions.Create(func(id string, expires int64) string {
		return mac(o.token, "ui-session-key", host, expected.Client, expected.Nonce, expected.Issued, expected.Proof, id, expires)
	})
	if err != nil {
		return httpx.Fail(429, err.Error())
	}
	httpx.JSON(w, 200, map[string]any{"session": map[string]any{"id": capability.ID, "expires": capability.Expires}, "proof": mac(o.token, "ui-session", host, expected.Client, expected.Nonce, expected.Issued, capability.ID, capability.Expires)})
	return nil
}
func serveSecure(sessions *Sessions, w http.ResponseWriter, r *http.Request, next http.Handler) {
	if r.Method != "POST" || r.Header.Get("x-nootify-ui") != "1" {
		httpx.WriteError(w, httpx.Fail(403, "Owner UI authorization required"))
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 4*1024*1024+1))
	if err != nil || len(data) > 4*1024*1024 {
		httpx.WriteError(w, httpx.Fail(413, "UI request exceeds limit"))
		return
	}
	var envelope Envelope
	if json.Unmarshal(data, &envelope) != nil {
		httpx.WriteError(w, httpx.Fail(403, "Invalid UI request"))
		return
	}
	codec, op, err := sessions.Open(envelope)
	if err != nil {
		httpx.WriteError(w, httpx.Fail(403, err.Error()))
		return
	}
	encrypted := newEncryptedWriter(w, codec, envelope.Request)
	defer encrypted.end()
	if !pathPattern.MatchString(op.Path) || op.Path == "/ui/api/secure" || (op.Method != "GET" && op.Method != "POST") || len(op.Body) > 1024*1024 {
		httpx.WriteError(encrypted, httpx.Fail(400, "Invalid owner UI operation"))
		return
	}
	if op.Path == "/ui/api/auth/revoke" {
		if op.Method != "POST" {
			httpx.WriteError(encrypted, httpx.Fail(405, "Session revocation requires POST"))
			return
		}
		sessions.Revoke(envelope.ID)
		httpx.JSON(encrypted, 200, map[string]bool{"revoked": true})
		return
	}
	inner := r.Clone(context.WithValue(r.Context(), authenticatedKey{}, true))
	inner.Method = op.Method
	inner.URL = &url.URL{Path: op.Path}
	inner.RequestURI = op.Path
	inner.Body = io.NopCloser(strings.NewReader(op.Body))
	inner.ContentLength = int64(len(op.Body))
	inner.Header = r.Header.Clone()
	inner.Header.Set("x-nootify-ui", "1")
	next.ServeHTTP(encrypted, inner)
}

type encryptedWriter struct {
	w                http.ResponseWriter
	codec            *codec
	request          string
	headers          http.Header
	status, sequence int
	sent, ended      bool
	failure          error
}

func newEncryptedWriter(w http.ResponseWriter, codec *codec, request string) *encryptedWriter {
	w.Header().Set("content-type", encryptedType+"; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("referrer-policy", "no-referrer")
	w.Header().Set("x-content-type-options", "nosniff")
	w.WriteHeader(200)
	return &encryptedWriter{w: w, codec: codec, request: request, headers: make(http.Header), status: 200}
}
func (w *encryptedWriter) Header() http.Header { return w.headers }
func (w *encryptedWriter) WriteHeader(status int) {
	if !w.sent {
		w.status = status
	}
}
func (w *encryptedWriter) frame(frame Frame) error {
	if w.failure != nil {
		return w.failure
	}
	envelope, err := w.codec.seal(frame, w.request, responseDirection(w.sequence))
	if err == nil {
		w.sequence++
		err = json.NewEncoder(w.w).Encode(envelope)
	}
	w.failure = err
	return err
}
func (w *encryptedWriter) sendHeaders() error {
	if w.sent {
		return w.failure
	}
	w.sent = true
	headers := map[string]string{}
	for _, key := range []string{"content-type", "content-disposition"} {
		if v := w.headers.Get(key); v != "" {
			headers[key] = v
		}
	}
	return w.frame(Frame{Type: "headers", Status: w.status, Headers: headers})
}
func (w *encryptedWriter) Write(data []byte) (int, error) {
	if w.ended {
		return 0, errors.New("response already ended")
	}
	if err := w.sendHeaders(); err != nil {
		return 0, err
	}
	for start := 0; start < len(data); start += 64 * 1024 {
		if err := w.frame(Frame{Type: "data", Data: b64.EncodeToString(data[start:min(start+64*1024, len(data))])}); err != nil {
			return start, err
		}
	}
	return len(data), nil
}
func (w *encryptedWriter) Flush() {
	_ = w.sendHeaders()
	if flusher, ok := w.w.(http.Flusher); ok {
		flusher.Flush()
	}
}
func (w *encryptedWriter) end() {
	if w.ended {
		return
	}
	w.ended = true
	if w.sendHeaders() == nil {
		_ = w.frame(Frame{Type: "end"})
	}
}

const contentPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.feishucdn.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

func Assets(assets fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		name := ""
		switch r.URL.Path {
		case "/":
			name = "index.html"
		case "/ui/styles.css":
			name = "styles.css"
		default:
			if strings.HasPrefix(r.URL.Path, "/ui/") {
				name = strings.TrimPrefix(r.URL.Path, "/")
			}
		}
		if name == "" || !fs.ValidPath(name) || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(assets, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		kind := mime.TypeByExtension(path.Ext(name))
		if kind == "" {
			kind = "application/octet-stream"
		}
		w.Header().Set("content-type", kind)
		w.Header().Set("cache-control", "no-store")
		w.Header().Set("referrer-policy", "no-referrer")
		w.Header().Set("x-content-type-options", "nosniff")
		w.Header().Set("content-security-policy", contentPolicy)
		w.Header().Set("content-length", fmt.Sprint(len(data)))
		if r.Method != "HEAD" {
			_, _ = w.Write(data)
		}
	})
}
