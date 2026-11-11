// Package webui serves trusted UI assets and the cookie-free authenticated UI
// protocol in Go. A desktop gateway is owned by its context, never by a child
// process or an idle stdin lease.
package webui

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sync"
	"time"
)

const encryptedType = "application/x-nootify-encrypted"

var noncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)
var routePattern = regexp.MustCompile(`^#/[a-z-]+(?:/[a-z-]+)?$`)
var pathPattern = regexp.MustCompile(`^/ui/api/[a-z/-]+$`)
var b64 = base64.RawURLEncoding

type Capability struct {
	ID      string `json:"id"`
	Key     string `json:"key"`
	Expires int64  `json:"expires"`
}
type Envelope struct {
	ID      string `json:"id"`
	Request string `json:"request"`
	IV      string `json:"iv"`
	Data    string `json:"data"`
}
type Operation struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   string `json:"body,omitempty"`
}
type Frame struct {
	Type    string            `json:"type"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Data    string            `json:"data,omitempty"`
}
type codec struct {
	capability Capability
	aead       cipher.AEAD
}

func nonce(size int) string {
	data := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, data); err != nil {
		panic(err)
	}
	return b64.EncodeToString(data)
}
func mac(token string, parts ...any) string {
	data, _ := json.Marshal(parts)
	h := hmac.New(sha256.New, []byte(token))
	_, _ = h.Write(data)
	return b64.EncodeToString(h.Sum(nil))
}
func equal(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }
func newCodec(c Capability) (*codec, error) {
	key, err := b64.DecodeString(c.Key)
	if err != nil || len(key) != 32 || !noncePattern.MatchString(c.ID) {
		return nil, errors.New("invalid UI capability")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	return &codec{c, aead}, err
}
func (c *codec) aad(request, direction string) []byte {
	raw, _ := json.Marshal([]string{"nootify-ui-v1", c.capability.ID, request, direction})
	return raw
}
func (c *codec) seal(value any, request, direction string) (Envelope, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return Envelope{}, err
	}
	iv := make([]byte, c.aead.NonceSize())
	if _, err = rand.Read(iv); err != nil {
		return Envelope{}, err
	}
	encrypted := c.aead.Seal(nil, iv, raw, c.aad(request, direction))
	return Envelope{c.capability.ID, request, b64.EncodeToString(iv), b64.EncodeToString(encrypted)}, nil
}
func (c *codec) open(e Envelope, request, direction string, out any) error {
	if e.ID != c.capability.ID || e.Request != request {
		return errors.New("invalid UI envelope")
	}
	iv, err := b64.DecodeString(e.IV)
	if err != nil || len(iv) != c.aead.NonceSize() {
		return errors.New("invalid UI envelope")
	}
	data, err := b64.DecodeString(e.Data)
	if err != nil {
		return errors.New("invalid UI envelope")
	}
	plain, err := c.aead.Open(nil, iv, data, c.aad(request, direction))
	if err != nil {
		return errors.New("invalid UI authorization")
	}
	if err = json.Unmarshal(plain, out); err != nil {
		return errors.New("invalid UI payload")
	}
	return nil
}
func Route(route string) (string, error) {
	if route == "" {
		return "#/logs", nil
	}
	if !routePattern.MatchString(route) {
		return "", errors.New("invalid local UI route")
	}
	return route, nil
}

type session struct {
	codec *codec
	seen  time.Time
	used  map[string]bool
}
type Sessions struct {
	mu      sync.Mutex
	entries map[string]*session
	idle    bool
}

func NewSessions(idle bool) *Sessions { return &Sessions{entries: map[string]*session{}, idle: idle} }
func (s *Sessions) Create(derive func(string, int64) string) (Capability, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, v := range s.entries {
		if v.codec.capability.Expires <= now.UnixMilli() || s.idle && now.Sub(v.seen) >= 3*time.Minute {
			delete(s.entries, id)
		}
	}
	if len(s.entries) >= 32 {
		return Capability{}, errors.New("too many authorized UI windows")
	}
	c := Capability{ID: nonce(24), Expires: now.Add(8 * time.Hour).UnixMilli()}
	if derive != nil {
		c.Key = derive(c.ID, c.Expires)
	} else {
		c.Key = nonce(32)
	}
	cd, err := newCodec(c)
	if err != nil {
		return Capability{}, err
	}
	s.entries[c.ID] = &session{codec: cd, seen: now, used: map[string]bool{}}
	return c, nil
}
func (s *Sessions) Open(e Envelope) (*codec, Operation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.entries[e.ID]
	if v == nil || !noncePattern.MatchString(e.Request) || v.codec.capability.Expires <= time.Now().UnixMilli() || s.idle && time.Since(v.seen) >= 3*time.Minute || v.used[e.Request] || len(v.used) >= 32768 {
		return nil, Operation{}, errors.New("owner UI authorization expired")
	}
	var op Operation
	if err := v.codec.open(e, e.Request, "request", &op); err != nil {
		return nil, op, err
	}
	v.used[e.Request] = true
	v.seen = time.Now()
	return v.codec, op, nil
}
func (s *Sessions) Revoke(id string)        { s.mu.Lock(); delete(s.entries, id); s.mu.Unlock() }
func (s *Sessions) Clear()                  { s.mu.Lock(); s.entries = map[string]*session{}; s.mu.Unlock() }
func responseDirection(sequence int) string { return fmt.Sprintf("response:%d", sequence) }
