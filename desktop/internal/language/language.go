// Package language owns desktop language preferences, independently of the daemon.
package language

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Preference string
type Locale string

const (
	System  Preference = "system"
	Chinese Preference = "zh-CN"
	English Preference = "en"
	ZH      Locale     = "zh-CN"
	EN      Locale     = "en"
)

type View struct {
	Preference Preference `json:"preference"`
	Locale     Locale     `json:"locale"`
}

func Valid(p Preference) bool { return p == System || p == Chinese || p == English }
func Resolve(s string) Locale {
	if strings.HasPrefix(strings.ToLower(s), "zh") {
		return ZH
	}
	return EN
}
func NewView(p Preference, system Locale) View {
	l := system
	if p == Chinese {
		l = ZH
	}
	if p == English {
		l = EN
	}
	return View{p, l}
}

// BridgeTag uses BCP 47 private use to carry the preference through MyGo's
// regenerated document-start bridge. SetLanguages changes supported languages,
// not the user's OS preference, and persists nothing. The Go file remains authoritative.
func (v View) BridgeTag() string {
	suffix := string(v.Preference)
	if v.Preference == Chinese {
		suffix = "zh"
	}
	return string(v.Locale) + "-x-nootify-" + suffix
}
func (v View) Script() string {
	data, _ := json.Marshal(v)
	return "window.__NOOTIFY_LANGUAGE__ = " + string(data) + "; window.dispatchEvent(new CustomEvent('nootify-language', {detail:window.__NOOTIFY_LANGUAGE__}));"
}

// SeedScript is immutable. MyGo supplies its newly regenerated locale before this
// script on every navigation, so reload never flashes an obsolete preference.
func (v View) SeedScript() string {
	data, _ := json.Marshal(v)
	return `const tags = {"en-x-nootify-system":{preference:"system",locale:"en"},"zh-CN-x-nootify-system":{preference:"system",locale:"zh-CN"},"en-x-nootify-en":{preference:"en",locale:"en"},"zh-CN-x-nootify-zh":{preference:"zh-CN",locale:"zh-CN"}};
window.__NOOTIFY_LANGUAGE__ = tags[window.mygo?.locale] || ` + string(data) + `;`
}

type Store struct {
	mu     sync.Mutex
	path   string
	view   View
	system func() Locale
}

func Load(path string, system func() Locale) *Store {
	p, err := read(path)
	if err != nil {
		p = System
	}
	return &Store{path: path, view: NewView(p, system()), system: system}
}
func (s *Store) View() View { s.mu.Lock(); defer s.mu.Unlock(); return s.view }
func (s *Store) Set(p Preference) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !Valid(p) {
		return s.view, errors.New("invalid app language")
	}
	if s.path != "" {
		if err := write(s.path, p); err != nil {
			return s.view, err
		}
	}
	s.view = NewView(p, s.system())
	return s.view, nil
}
func (s *Store) RefreshSystem() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.view.Preference != System {
		return false
	}
	v := NewView(System, s.system())
	if v == s.view {
		return false
	}
	s.view = v
	return true
}
func read(path string) (Preference, error) {
	if path == "" {
		return System, nil
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return System, nil
	}
	if err != nil {
		return System, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 1025))
	if err != nil {
		return System, err
	}
	if len(data) > 1024 {
		return System, errors.New("language preference exceeds 1 KiB")
	}
	var settings struct {
		Preference Preference `json:"preference"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&settings); err != nil {
		return System, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return System, errors.New("invalid trailing language data")
	}
	if !Valid(settings.Preference) {
		return System, errors.New("invalid language preference")
	}
	return settings.Preference, nil
}
func write(path string, p Preference) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".language-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	data, _ := json.Marshal(struct {
		Preference Preference `json:"preference"`
	}{p})
	data = append(data, '\n')
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func (l Locale) Format(key Text, values map[string]string) string {
	// Replace each original placeholder once; inserted diagnostics remain literal.
	template := l.Text(key)
	var out strings.Builder
	for {
		start := strings.IndexByte(template, '{')
		if start < 0 {
			out.WriteString(template)
			break
		}
		out.WriteString(template[:start])
		template = template[start:]
		end := strings.IndexByte(template, '}')
		if end < 0 {
			out.WriteString(template)
			break
		}
		if v, ok := values[template[1:end]]; ok {
			out.WriteString(v)
		} else {
			out.WriteString(template[:end+1])
		}
		template = template[end+1:]
	}
	return out.String()
}
func (v View) String() string { return fmt.Sprintf("%s (%s)", v.Locale, v.Preference) }
