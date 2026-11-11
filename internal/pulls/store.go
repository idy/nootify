package pulls

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"

	"github.com/idy/nootify/internal/privatepath"
)

var regexpUpstream = regexp.MustCompile(`(?i)^upstream(?:[-_].*)?$`)

func jsonString(raw json.RawMessage) bool {
	var value string
	return len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &value) == nil
}
func jsonStringArray(raw json.RawMessage) bool {
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || entries == nil {
		return false
	}
	for _, entry := range entries {
		if !jsonString(entry) {
			return false
		}
	}
	return true
}

// Old account-wide caches must never become subscription candidates, even as a startup fallback.
func validCache(data []byte) (collected, bool) {
	var envelope struct {
		Version  int             `json:"version"`
		Snapshot json.RawMessage `json:"snapshot"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.Version != 3 {
		return collected{}, false
	}
	var current collected
	if json.Unmarshal(envelope.Snapshot, &current) != nil {
		return collected{}, false
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(envelope.Snapshot, &raw)
	if current.Internal == nil || current.Upstream == nil || len(current.Internal)+len(current.Upstream) > 50000 || current.Involved == nil || len(current.Involved) > 10000 || current.LocalForks == nil || current.Authors == nil || current.Warnings == nil || len(current.Warnings) > 5000 {
		return collected{}, false
	}
	var refresh map[string]json.RawMessage
	if json.Unmarshal(raw["refresh"], &refresh) != nil || refresh["running"] == nil {
		return collected{}, false
	}
	var running bool
	if string(refresh["running"]) == "null" || json.Unmarshal(refresh["running"], &running) != nil {
		return collected{}, false
	}
	for _, name := range []string{"startedAt", "finishedAt", "lastSuccessAt"} {
		if r, ok := refresh[name]; ok {
			var s string
			if json.Unmarshal(r, &s) != nil || !validTime(s) {
				return collected{}, false
			}
		}
	}
	if r, ok := refresh["error"]; ok {
		var v string
		if string(r) == "null" || json.Unmarshal(r, &v) != nil {
			return collected{}, false
		}
	}
	for _, name := range []string{"authors", "localForks", "warnings"} {
		if !jsonStringArray(raw[name]) {
			return collected{}, false
		}
	}
	for _, p := range append(append([]PullRequest{}, current.Internal...), current.Upstream...) {
		if p.Number < 1 || !repositoryName(p.Repository) {
			return collected{}, false
		}
		if _, ok := ParseGitHubPull(p.URL); !ok {
			return collected{}, false
		}
		if p.CI.Passed < 0 || p.CI.Failed < 0 || p.CI.Pending < 0 || p.CI.Total < 0 {
			return collected{}, false
		}
	}
	// Required scalar fields must be present; Go's zero values alone cannot distinguish a truncated cache.
	for _, queue := range []string{"internal", "upstream"} {
		var pulls []map[string]json.RawMessage
		if json.Unmarshal(raw[queue], &pulls) != nil {
			return collected{}, false
		}
		for _, p := range pulls {
			for _, f := range []string{"url", "title", "repository", "author", "updatedAt", "reviewDecision", "mergeable"} {
				var s string
				if p[f] == nil || string(p[f]) == "null" || json.Unmarshal(p[f], &s) != nil {
					return collected{}, false
				}
			}
			for _, name := range []string{"headRepository", "headBranch"} {
				if raw, present := p[name]; present && !jsonString(raw) {
					return collected{}, false
				}
			}
			var draft bool
			if p["isDraft"] == nil || json.Unmarshal(p["isDraft"], &draft) != nil || string(p["isDraft"]) == "null" {
				return collected{}, false
			}
			var ci map[string]json.RawMessage
			if json.Unmarshal(p["ci"], &ci) != nil || !jsonString(ci["state"]) {
				return collected{}, false
			}
			for _, f := range []string{"passed", "failed", "pending", "total"} {
				var v int
				if ci[f] == nil || string(ci[f]) == "null" || json.Unmarshal(ci[f], &v) != nil || v < 0 {
					return collected{}, false
				}
			}
		}
	}
	for _, item := range current.Involved {
		if !repositoryName(item.Repository) || item.Sources == nil {
			return collected{}, false
		}
		for _, source := range item.Sources {
			if !has([]string{"claude", "codex", "opencode"}, source.Agent) || !has([]string{"claude-code", "claude-desktop", "codex", "opencode"}, source.Adapter) || source.Pulls == nil || (source.LastActive != "" && !validTime(source.LastActive)) {
				return collected{}, false
			}
			for _, p := range source.Pulls {
				if !repositoryName(p.Repository) || p.Number < 1 || p.Number > 9007199254740991 {
					return collected{}, false
				}
				if _, ok := ParseGitHubPull(p.URL); !ok {
					return collected{}, false
				}
			}
		}
	}
	var involved []struct {
		Sources []map[string]json.RawMessage `json:"sources"`
	}
	_ = json.Unmarshal(raw["involved"], &involved)
	for _, i := range involved {
		for _, source := range i.Sources {
			for _, f := range []string{"id", "name", "directory"} {
				var v string
				if source[f] == nil || string(source[f]) == "null" || json.Unmarshal(source[f], &v) != nil {
					return collected{}, false
				}
			}
			if raw, present := source["branch"]; present && !jsonString(raw) {
				return collected{}, false
			}
			if raw, present := source["archived"]; present {
				var value bool
				if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
					return collected{}, false
				}
			}
			if raw, present := source["lastActive"]; present {
				var value string
				if !jsonString(raw) || json.Unmarshal(raw, &value) != nil || !validTime(value) {
					return collected{}, false
				}
			}
			var v bool
			if source["fromRepository"] == nil || string(source["fromRepository"]) == "null" || json.Unmarshal(source["fromRepository"], &v) != nil {
				return collected{}, false
			}
		}
	}
	for _, r := range current.LocalForks {
		if !repositoryName(r) {
			return collected{}, false
		}
	}
	current.Refresh.Running = false
	sortPulls(current.Internal)
	sortPulls(current.Upstream)
	return current, true
}
func (s *Service) loadCache() {
	path := filepath.Join(s.opts.StateDir, "pulls-cache.json")
	data, err := readBounded(path, 32*1024*1024)
	if errors.Is(err, os.ErrNotExist) {
		// Accept the alternate cache filename only with the same session-scoped version-3 envelope.
		path = filepath.Join(s.opts.StateDir, "pulls.json")
		data, err = readBounded(path, 32*1024*1024)
	}
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.current.Warnings = append(s.current.Warnings, "Could not load session PR cache: "+safeError(err))
		}
		return
	}
	if current, ok := validCache(data); ok {
		if e := privatepath.Protect(path, false); e != nil {
			s.current.Warnings = append(s.current.Warnings, "Could not load session PR cache: "+safeError(e))
			return
		}
		s.current = current
	} else {
		s.current.Warnings = append(s.current.Warnings, "Rebuilding subscriptions from session metadata; the earlier account-wide cache is not used.")
	}
}
func (s *Service) loadChoices() {
	path := filepath.Join(s.opts.StateDir, "repo-preferences.json")
	data, e := readBounded(path, 1024*1024)
	if e != nil {
		if !errors.Is(e, os.ErrNotExist) {
			s.current.Warnings = append(s.current.Warnings, "Could not load repository choices: "+safeError(e))
		}
		return
	}
	var input struct {
		Version int            `json:"version"`
		Choices []FollowChoice `json:"choices"`
	}
	var raw struct {
		Choices []map[string]json.RawMessage `json:"choices"`
	}
	if json.Unmarshal(data, &input) != nil || json.Unmarshal(data, &raw) != nil || input.Version != 1 || input.Choices == nil {
		s.current.Warnings = append(s.current.Warnings, "Ignored invalid repository follow choices.")
		return
	}
	for i, c := range input.Choices {
		var follow bool
		if !repositoryName(c.Repository) || raw.Choices[i]["follow"] == nil || string(raw.Choices[i]["follow"]) == "null" || json.Unmarshal(raw.Choices[i]["follow"], &follow) != nil {
			s.current.Warnings = append(s.current.Warnings, "Ignored invalid repository follow choices.")
			return
		}
	}
	for _, c := range input.Choices {
		s.putChoiceLocked(c)
	}
}
func (s *Service) putChoiceLocked(c FollowChoice) {
	k := key(c.Repository)
	if _, ok := s.choices[k]; !ok {
		s.choiceOrder = append(s.choiceOrder, k)
	}
	s.choices[k] = c
}
func (s *Service) choicesLocked() []FollowChoice {
	choices := []FollowChoice{}
	for _, k := range s.choiceOrder {
		if c, ok := s.choices[k]; ok {
			choices = append(choices, c)
		}
	}
	return choices
}
func (s *Service) writeChoices(choices []FollowChoice) error {
	return writePrivate(s.opts.StateDir, "repo-preferences.json", struct {
		Version int            `json:"version"`
		Choices []FollowChoice `json:"choices"`
	}{1, choices})
}

// SetChoice's nil follow resets the repository to its automatic session-derived subscription.
func (s *Service) SetChoice(repository string, follow *bool) (RepositoryEntry, error) {
	if !repositoryName(repository) {
		return RepositoryEntry{}, &HTTPError{400, "Expected an owner/name GitHub repository"}
	}
	s.writes.Lock()
	defer s.writes.Unlock()
	s.mu.Lock()
	name := repository
	automatic := false
	for _, e := range s.repositoriesLocked() {
		if key(e.Repository) == key(repository) {
			name = e.Repository
			automatic = len(e.Sources) > 0
			break
		}
	}
	if follow == nil || *follow == automatic {
		delete(s.choices, key(name))
		next := s.choiceOrder[:0]
		for _, k := range s.choiceOrder {
			if k != key(name) {
				next = append(next, k)
			}
		}
		s.choiceOrder = next
	} else {
		s.putChoiceLocked(FollowChoice{name, *follow})
	}
	choices := s.choicesLocked()
	s.mu.Unlock()
	if e := s.writeChoices(choices); e != nil {
		return RepositoryEntry{}, e
	}
	s.RefreshSoon()
	for _, e := range s.Repositories() {
		if key(e.Repository) == key(name) {
			return e, nil
		}
	}
	return emptyEntry(name), nil
}
func (s *Service) Preferences() (Preferences, error) {
	_, source, _, e := loadConfig(s.opts.StateDir, s.opts.Home)
	if e != nil {
		return Preferences{}, e
	}
	s.mu.RLock()
	preferences := Preferences{Follow: s.choicesLocked()}
	s.mu.RUnlock()
	if source != "defaults" {
		preferences.Config, e = readBounded(source, 1024*1024)
	}
	return preferences, e
}

// Restore validates before replacing deliberate choices. Config is written atomically in the existing TS format.
func (s *Service) Restore(preferences Preferences) error {
	if len(preferences.Config) > 0 {
		if _, e := ParseConfig(preferences.Config, s.opts.Home); e != nil {
			return e
		}
	}
	if len(preferences.Follow) > 10000 {
		return errors.New("Too many repository follow choices")
	}
	for _, c := range preferences.Follow {
		if !repositoryName(c.Repository) {
			return errors.New("Expected an owner/name GitHub repository")
		}
	}
	s.writes.Lock()
	defer s.writes.Unlock()
	if len(preferences.Config) > 0 {
		var value any
		if e := json.Unmarshal(preferences.Config, &value); e != nil {
			return e
		}
		if e := writePrivate(s.opts.StateDir, "pulls.config.json", value); e != nil {
			return e
		}
	}
	if preferences.Follow != nil {
		s.mu.Lock()
		s.choices = map[string]FollowChoice{}
		s.choiceOrder = []string{}
		for _, c := range preferences.Follow {
			s.putChoiceLocked(c)
		}
		choices := s.choicesLocked()
		s.mu.Unlock()
		if e := s.writeChoices(choices); e != nil {
			return e
		}
	}
	s.RefreshSoon()
	return nil
}
