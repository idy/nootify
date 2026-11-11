package settings

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/idy/nootify/internal/privatepath"
)

type cacheEntry struct {
	Version   int       `json:"version"`
	Scope     string    `json:"scope"`
	Directory Directory `json:"directory"`
	At        int64     `json:"at"`
}
type directoryCache struct {
	mu      sync.Mutex
	path    string
	now     func() time.Time
	memory  *cacheEntry
	cleared bool
}

func scopeKey(c Credentials) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode([]string{c.AppID, c.AppSecret})
	sum := sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte{'\n'}))
	return hex.EncodeToString(sum[:])
}
func (c *directoryCache) valid(at int64) bool {
	now := c.now().UnixMilli()
	return at >= 0 && at <= now && now-at < directoryMaxAge.Milliseconds()
}
func sanitizeDirectory(d Directory, app string) (Directory, bool) {
	if d.AppID != app || d.Users == nil || len(d.Users) > 5000 {
		return Directory{}, false
	}
	out := Directory{AppID: app, Users: []Recipient{}, Truncated: d.Truncated, PermissionLimited: d.PermissionLimited}
	for _, v := range d.Users {
		if len(v.OpenID) > 4096 || !openPattern.MatchString(v.OpenID) || trim(v.Name) == "" || len(v.Name) > 4096 {
			return Directory{}, false
		}
		v.Name = trim(v.Name)
		v.EnName = trim(v.EnName)
		v.Nickname = trim(v.Nickname)
		if len(v.EnName) > 4096 {
			v.EnName = ""
		}
		if len(v.Nickname) > 4096 {
			v.Nickname = ""
		}
		v.AvatarURL = avatarURL(v.AvatarURL)
		out.Users = append(out.Users, v)
	}
	if d.Permission != nil {
		p := &Permission{Scopes: []string{}}
		seen := map[string]bool{}
		for _, v := range d.Permission.Scopes {
			if len(v) <= 256 && contactPattern.MatchString(v) && !seen[v] && len(p.Scopes) < 100 {
				seen[v] = true
				p.Scopes = append(p.Scopes, v)
			}
		}
		if consoleURL(d.Permission.URL, app) {
			p.URL = d.Permission.URL
		}
		out.Permission = p
	}
	return out, true
}
func (c *directoryCache) read(creds Credentials) *cacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	scope := scopeKey(creds)
	if c.memory != nil && c.memory.Scope == scope && c.valid(c.memory.At) {
		e := *c.memory
		e.Directory = cloneDirectory(e.Directory)
		return &e
	}
	if c.memory != nil && !c.valid(c.memory.At) {
		c.memory = nil
	}
	if c.cleared {
		return nil
	}
	if e := privatepath.Protect(c.path, false); e != nil {
		return nil
	}
	info, e := os.Lstat(c.path)
	if e != nil || !info.Mode().IsRegular() || info.Size() > 32*1024*1024 {
		return nil
	}
	f, e := os.Open(c.path)
	if e != nil {
		return nil
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Size() > 32*1024*1024 {
		return nil
	}
	b, e := io.ReadAll(io.LimitReader(f, opened.Size()+1))
	if e != nil || int64(len(b)) > opened.Size() {
		return nil
	}
	var entry cacheEntry
	if json.Unmarshal(b, &entry) != nil || entry.Version != 1 || entry.Scope != scope || !c.valid(entry.At) {
		return nil
	}
	var raw struct {
		Directory map[string]json.RawMessage `json:"directory"`
	}
	if json.Unmarshal(b, &raw) != nil || string(raw.Directory["truncated"]) != "true" && string(raw.Directory["truncated"]) != "false" || string(raw.Directory["permission_limited"]) != "true" && string(raw.Directory["permission_limited"]) != "false" {
		return nil
	}
	d, ok := sanitizeDirectory(entry.Directory, creds.AppID)
	if !ok {
		return nil
	}
	entry.Directory = d
	c.memory = &entry
	out := entry
	out.Directory = cloneDirectory(d)
	return &out
}
func (c *directoryCache) write(creds Credentials, d Directory, at int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	clean, ok := sanitizeDirectory(d, creds.AppID)
	if !ok || !c.valid(at) {
		return
	}
	entry := cacheEntry{Version: 1, Scope: scopeKey(creds), Directory: clean, At: at}
	b, e := json.Marshal(entry)
	if e != nil || len(b) > 32*1024*1024 {
		return
	}
	c.memory = &entry
	c.cleared = false
	_ = atomicPrivate(c.path, b)
}
func (c *directoryCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.memory = nil
	c.cleared = true
	_ = os.Remove(c.path)
}
func atomicPrivate(path string, data []byte) error {
	dir := filepath.Dir(path)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	if e := privatepath.Protect(dir, true); e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, ".nootify-*.tmp")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if e = privatepath.Protect(f.Name(), false); e != nil {
		return e
	}
	if _, e = f.Write(data); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
