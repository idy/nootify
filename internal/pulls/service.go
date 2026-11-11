package pulls

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// Options injects storage, identity, reporting, and optional discovery/network boundaries.
type Options struct {
	StateDir        string
	Home            string
	Token           func() string
	Report          func(map[string]any)
	Sources         *Sources
	HTTPClient      *http.Client
	GraphQLURL      string
	RefreshInterval time.Duration
	// Discover and Collect are optional integration/test seams. Defaults retain all production discovery and collection behavior.
	Discover func(context.Context) (DiscoveryResult, error)
	Collect  func(context.Context, Config, Targets) (Collection, error)
}
type involvement struct {
	Repository string              `json:"repository"`
	Sources    []RepositorySession `json:"sources"`
}
type collected struct {
	Internal   []PullRequest `json:"internal"`
	Upstream   []PullRequest `json:"upstream"`
	Involved   []involvement `json:"involved"`
	LocalForks []string      `json:"localForks"`
	Authors    []string      `json:"authors"`
	Refresh    RefreshState  `json:"refresh"`
	Warnings   []string      `json:"warnings"`
}
type FollowChoice struct {
	Repository string `json:"repository"`
	Follow     bool   `json:"follow"`
}
type Preferences struct {
	Config json.RawMessage `json:"config,omitempty"`
	Follow []FollowChoice  `json:"follow"`
}
type Service struct {
	opts                              Options
	mu                                sync.RWMutex
	lifecycle                         sync.Mutex
	writes                            sync.Mutex
	current                           collected
	choices                           map[string]FollowChoice
	choiceOrder                       []string
	started, stopped, running, queued bool
	ctx                               context.Context
	cancel                            context.CancelFunc
	refresh                           chan struct{}
	wg                                sync.WaitGroup
	discoverer                        discoverer
}

func New(opts Options) (*Service, error) {
	if opts.StateDir == "" {
		return nil, errors.New("pulls StateDir is required")
	}
	if opts.Home == "" {
		opts.Home, _ = os.UserHomeDir()
	}
	if opts.RefreshInterval <= 0 {
		opts.RefreshInterval = 5 * time.Minute
	}
	if opts.GraphQLURL == "" {
		opts.GraphQLURL = defaultGraphQLURL
	}
	opts.HTTPClient = defaultHTTPClient(opts.HTTPClient)
	if e := os.MkdirAll(opts.StateDir, 0700); e != nil {
		return nil, e
	}
	if e := os.Chmod(opts.StateDir, 0700); e != nil {
		return nil, e
	}
	s := &Service{opts: opts, choices: map[string]FollowChoice{}, choiceOrder: []string{}, current: collected{Internal: []PullRequest{}, Upstream: []PullRequest{}, Involved: []involvement{}, LocalForks: []string{}, Authors: []string{}, Warnings: []string{}}, refresh: make(chan struct{}, 1)}
	s.loadCache()
	s.loadChoices()
	return s, nil
}

// Start loads no remote data on the caller's goroutine; refreshes run independently and are canceled by ctx or Close.
func (s *Service) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return nil
	}
	if e := ctx.Err(); e != nil {
		return e
	}
	s.ctx, s.cancel = context.WithCancel(ctx)
	s.started = true
	s.stopped = false
	s.queued = false
	s.wg.Add(1)
	go s.loop()
	s.beginLocked()
	return nil
}
func (s *Service) loop() {
	defer s.wg.Done()
	ticker := time.NewTicker(s.opts.RefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			s.mu.Lock()
			s.running = false
			s.current.Refresh.Running = false
			s.mu.Unlock()
			return
		case <-ticker.C:
			s.Refresh()
		case <-s.refresh:
			s.update(s.ctx)
			s.mu.Lock()
			s.running = false
			s.current.Refresh.Running = false
			if s.queued && !s.stopped && s.ctx.Err() == nil {
				s.queued = false
				s.beginLocked()
			}
			s.mu.Unlock()
		}
	}
}
func (s *Service) beginLocked() {
	if !s.started || s.stopped || s.running || s.ctx.Err() != nil {
		return
	}
	s.running = true
	s.current.Refresh.Running = true
	s.current.Refresh.StartedAt = nowISO()
	s.current.Refresh.Error = ""
	s.current.Refresh.SignedOut = false
	select {
	case s.refresh <- struct{}{}:
	default:
	}
}

// Refresh coalesces repeated explicit refreshes; RefreshSoon guarantees a subsequent query after a change during work.
func (s *Service) Refresh() { s.mu.Lock(); defer s.mu.Unlock(); s.beginLocked() }
func (s *Service) RefreshSoon() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started || s.stopped {
		return
	}
	if s.running {
		s.queued = true
	} else {
		s.beginLocked()
	}
}
func (s *Service) Close() error {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	s.stopped = true
	s.queued = false
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	s.writes.Lock()
	s.writes.Unlock()
	s.mu.Lock()
	s.started = false
	s.running = false
	s.current.Refresh.Running = false
	for {
		select {
		case <-s.refresh:
		default:
			s.mu.Unlock()
			return nil
		}
	}
}
func (s *Service) Status() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.stopped {
		return "stopped"
	}
	if s.running {
		return "refreshing"
	}
	if s.current.Refresh.SignedOut {
		return "signed_out"
	}
	if s.current.Refresh.Error != "" {
		if s.current.Refresh.LastSuccessAt != "" {
			return "stale"
		}
		return "error"
	}
	if s.current.Refresh.LastSuccessAt != "" {
		return "ready"
	}
	return "idle"
}
func emptyEntry(repo string) RepositoryEntry {
	return RepositoryEntry{Repository: repo, Agents: []string{}, Sources: []RepositorySession{}}
}
func (s *Service) repositoriesLocked() []RepositoryEntry {
	collator := collate.New(language.Und)
	entries := map[string]*RepositoryEntry{}
	entry := func(repo string) *RepositoryEntry {
		k := key(repo)
		if e := entries[k]; e != nil {
			return e
		}
		e := emptyEntry(repo)
		entries[k] = &e
		return &e
	}
	for _, item := range s.current.Involved {
		e := entry(item.Repository)
		e.Sources = append([]RepositorySession{}, item.Sources...)
		sort.SliceStable(e.Sources, func(i, j int) bool {
			a, b := e.Sources[i], e.Sources[j]
			if a.LastActive != b.LastActive {
				return a.LastActive > b.LastActive
			}
			return collator.CompareString(a.Name, b.Name) < 0
		})
		e.Sessions = len(e.Sources)
		links := map[string]bool{}
		for _, agent := range []string{"claude", "codex", "opencode"} {
			for _, source := range e.Sources {
				if source.Agent == agent {
					e.Agents = append(e.Agents, agent)
					break
				}
			}
		}
		for _, source := range e.Sources {
			e.AllPulls = e.AllPulls || source.FromRepository
			if source.LastActive > e.LastActive {
				e.LastActive = source.LastActive
			}
			for _, p := range source.Pulls {
				links[pullKey(p.Repository, p.Number)] = true
			}
		}
		e.LinkedPulls = len(links)
	}
	for _, choice := range s.choices {
		entry(choice.Repository)
	}
	for _, queue := range []struct {
		pulls    []PullRequest
		internal bool
	}{{s.current.Internal, true}, {s.current.Upstream, false}} {
		for _, p := range queue.pulls {
			if e := entries[key(p.Repository)]; e != nil {
				if queue.internal {
					e.Pulls.Internal++
				} else {
					e.Pulls.Upstream++
				}
				if has(s.current.Authors, p.Author) {
					e.Authored++
				}
			}
		}
	}
	result := []RepositoryEntry{}
	for _, e := range entries {
		if c, ok := s.choices[key(e.Repository)]; ok {
			e.Followed = c.Follow
			if c.Follow {
				e.Choice = "follow"
			} else {
				e.Choice = "mute"
			}
			if c.Follow && len(e.Sources) == 0 {
				e.AllPulls = true
			}
		} else {
			e.Followed = len(e.Sources) > 0
		}
		result = append(result, *e)
	}
	sort.SliceStable(result, func(i, j int) bool {
		a, b := result[i], result[j]
		if a.Followed != b.Followed {
			return a.Followed
		}
		if a.LastActive != b.LastActive {
			return a.LastActive > b.LastActive
		}
		return collator.CompareString(key(a.Repository), key(b.Repository)) < 0
	})
	return result
}
func tracked(p PullRequest, e *RepositoryEntry) bool {
	return e != nil && e.Followed && (e.AllPulls || explicitSources(p, e.Sources) != nil)
}
func explicitSources(p PullRequest, sources []RepositorySession) []RepositorySession {
	var found []RepositorySession
	for _, source := range sources {
		for _, link := range source.Pulls {
			if pullKey(link.Repository, link.Number) == pullKey(p.Repository, p.Number) {
				found = append(found, source)
				break
			}
		}
	}
	return found
}
func associate(p PullRequest, e RepositoryEntry) PullRequest {
	sources := explicitSources(p, e.Sources)
	subscription := "session-pr"
	if len(sources) == 0 {
		subscription = "session-branch"
		for _, source := range e.Sources {
			if source.FromRepository && source.Branch != "" && source.Branch == p.HeadBranch {
				sources = append(sources, source)
			}
		}
	}
	if len(sources) == 0 {
		subscription = "session-repository"
		for _, source := range e.Sources {
			if source.FromRepository {
				sources = append(sources, source)
			}
		}
	}
	if len(sources) == 0 {
		subscription = "manual"
	}
	p.Sessions = []SessionReference{}
	for _, source := range sources {
		p.Sessions = append(p.Sessions, source.SessionReference)
	}
	p.Subscription = subscription
	return p
}
func clone[T any](v T) T { b, _ := json.Marshal(v); var out T; _ = json.Unmarshal(b, &out); return out }
func (s *Service) Repositories() []RepositoryEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return clone(s.repositoriesLocked())
}
func (s *Service) Snapshot() PullSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	repositories := s.repositoriesLocked()
	byName := map[string]*RepositoryEntry{}
	for i := range repositories {
		byName[key(repositories[i].Repository)] = &repositories[i]
	}
	visible := func(values []PullRequest) []PullRequest {
		out := []PullRequest{}
		for _, p := range values {
			if e := byName[key(p.Repository)]; tracked(p, e) {
				out = append(out, associate(p, *e))
			}
		}
		return out
	}
	internal, upstream := visible(s.current.Internal), visible(s.current.Upstream)
	refresh := s.current.Refresh
	refresh.Running = s.running
	return clone(PullSnapshot{Internal: internal, Upstream: upstream, Hidden: PullCounts{len(s.current.Internal) - len(internal), len(s.current.Upstream) - len(upstream)}, Repositories: repositories, Refresh: refresh, Warnings: nonNil(s.current.Warnings)})
}
func (s *Service) targetsLocked() Targets {
	targets := Targets{Repositories: []string{}, Pulls: []Target{}, LocalForks: append([]string{}, s.current.LocalForks...)}
	seen := map[string]bool{}
	for _, e := range s.repositoriesLocked() {
		if !e.Followed {
			continue
		}
		if e.AllPulls {
			targets.Repositories = append(targets.Repositories, e.Repository)
		}
		for _, source := range e.Sources {
			for _, p := range source.Pulls {
				k := pullKey(p.Repository, p.Number)
				if !seen[k] {
					seen[k] = true
					targets.Pulls = append(targets.Pulls, Target{p.Repository, p.Number})
				}
			}
		}
	}
	return targets
}
func (s *Service) discover(ctx context.Context, c *commands) ([]involvement, []string, []string, error) {
	found := DiscoveryResult{}
	var e error
	if s.opts.Discover != nil {
		found, e = s.opts.Discover(ctx)
	} else {
		found, e = s.discoverer.discover(ctx, DiscoveryOptions{Home: s.opts.Home, Sources: s.opts.Sources})
	}
	if e != nil {
		return nil, nil, nil, e
	}
	involved := map[string]*involvement{}
	order := []string{}
	forks := []string{}
	for _, session := range found.Sessions {
		if ctx.Err() != nil {
			return nil, nil, nil, ctx.Err()
		}
		repos := map[string]string{}
		repoOrder := []string{}
		addRepo := func(repo string) {
			k := key(repo)
			if _, ok := repos[k]; !ok {
				repoOrder = append(repoOrder, k)
			}
			repos[k] = repo
		}
		if origin := ParseGitHubRemote(session.Origin); origin != "" {
			addRepo(origin)
		}
		for _, dir := range session.Directories {
			remotes, err := c.readRemotes(ctx, dir)
			if err != nil {
				if ctx.Err() != nil {
					return nil, nil, nil, ctx.Err()
				}
				continue
			}
			origin := ""
			for _, remote := range remotes {
				addRepo(remote.Repository)
				if strings.EqualFold(remote.Name, "origin") {
					origin = remote.Repository
				}
			}
			if origin != "" {
				for _, remote := range remotes {
					if regexpUpstream.MatchString(remote.Name) && !strings.EqualFold(remote.Repository, origin) {
						forks = append(forks, origin)
						break
					}
				}
			}
		}
		related := map[string]string{}
		relatedOrder := append([]string{}, repoOrder...)
		for k, v := range repos {
			related[k] = v
		}
		for _, p := range session.Pulls {
			k := key(p.Repository)
			if _, ok := related[k]; !ok {
				relatedOrder = append(relatedOrder, k)
			}
			related[k] = p.Repository
		}
		for _, k := range relatedOrder {
			repo := related[k]
			item := involved[k]
			if item == nil {
				item = &involvement{Repository: repo, Sources: []RepositorySession{}}
				involved[k] = item
				order = append(order, k)
			} else {
				item.Repository = repo
			}
			pulls := []PullReference{}
			for _, p := range session.Pulls {
				if key(p.Repository) == k {
					pulls = append(pulls, p)
				}
			}
			_, fromRepo := repos[k]
			source := RepositorySession{SessionReference: SessionReference{session.ID, session.Title, session.Agent, session.Adapter}, Directory: session.Directory, Branch: session.Branch, Archived: session.Archived, LastActive: session.LastActive, FromRepository: fromRepo, Pulls: pulls}
			replaced := false
			for i, previous := range item.Sources {
				if previous.Adapter == source.Adapter && previous.ID == source.ID {
					item.Sources[i] = source
					replaced = true
					break
				}
			}
			if !replaced {
				item.Sources = append(item.Sources, source)
			}
		}
	}
	result := []involvement{}
	for _, k := range order {
		result = append(result, *involved[k])
	}
	warnings := append([]string{}, found.Warnings...)
	warnings = append(warnings, fmt.Sprintf("Subscriptions: %d local sessions; %d related repositories. PR targets come from persisted session links and those sessions' repositories.", len(found.Sessions), len(result)))
	return result, unique(forks), warnings, nil
}
func (s *Service) update(ctx context.Context) {
	commands := newCommands(s.opts.StateDir, s.opts.Token, s.opts.HTTPClient, s.opts.GraphQLURL)
	config, _, loadedWarnings, err := loadConfig(s.opts.StateDir, s.opts.Home)
	if err == nil {
		var involved []involvement
		var forks, warnings []string
		involved, forks, warnings, err = s.discover(ctx, commands)
		if err == nil && ctx.Err() == nil {
			s.mu.Lock()
			s.current.Involved = involved
			s.current.LocalForks = forks
			targets := s.targetsLocked()
			s.mu.Unlock()
			var result Collection
			if s.opts.Collect != nil {
				result, err = s.opts.Collect(ctx, config, targets)
			} else {
				result, err = collect(ctx, config, commands, targets)
			}
			if err == nil && ctx.Err() == nil {
				allWarnings := append(append(loadedWarnings, warnings...), result.Warnings...)
				s.mu.Lock()
				s.retainLocked(&result, &allWarnings)
				sortPulls(result.Internal)
				sortPulls(result.Upstream)
				now := nowISO()
				s.current.Internal = nonNil(result.Internal)
				s.current.Upstream = nonNil(result.Upstream)
				s.current.Authors = nonNil(result.Scope.Authors)
				s.current.Refresh = RefreshState{StartedAt: s.current.Refresh.StartedAt, FinishedAt: now, LastSuccessAt: now}
				s.current.Warnings = uniqueExact(allWarnings)
				cache := clone(s.current)
				s.mu.Unlock()
				if e := writePrivate(s.opts.StateDir, "pulls-cache.json", struct {
					Version  int       `json:"version"`
					Snapshot collected `json:"snapshot"`
				}{3, cache}); e != nil {
					s.mu.Lock()
					s.current.Warnings = append(s.current.Warnings, "Session PR cache was not saved: "+safeError(e))
					s.mu.Unlock()
				}
				visible := s.Snapshot()
				s.emit(map[string]any{"source": "pulls", "status": "refresh_completed", "reason": fmt.Sprintf("会话订阅：我们仓库 %d 个、上游 %d 个；来源仓库 %d 个", len(visible.Internal), len(visible.Upstream), len(visible.Repositories))})
				return
			}
		}
	}
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	s.mu.Lock()
	s.current.Refresh.Running = false
	s.current.Refresh.FinishedAt = nowISO()
	if errors.Is(err, ErrSignedOut) {
		s.current.Refresh.Error = ""
		s.current.Refresh.SignedOut = true
		s.mu.Unlock()
		return
	}
	s.current.Refresh.SignedOut = false
	if ctx.Err() == nil {
		s.current.Refresh.Error = safeError(err)
		var failure *CollectionError
		if errors.As(err, &failure) {
			s.current.Warnings = append(s.current.Warnings, failure.Warnings...)
		}
		s.current.Warnings = uniqueExact(append(s.current.Warnings, "Refresh failed; displaying the last good session-scoped PR snapshot."))
	}
	s.mu.Unlock()
	if ctx.Err() == nil {
		s.emit(map[string]any{"source": "pulls", "status": "refresh_failed", "error": safeError(err)})
	}
}
func (s *Service) retainLocked(result *Collection, warnings *[]string) {
	entries := map[string]*RepositoryEntry{}
	for _, e := range s.repositoriesLocked() {
		e := e
		entries[key(e.Repository)] = &e
	}
	for _, queue := range []struct {
		previous   []PullRequest
		current    *[]PullRequest
		incomplete bool
		internal   bool
	}{{s.current.Internal, &result.Internal, result.IncompleteInternal, true}, {s.current.Upstream, &result.Upstream, result.IncompleteUpstream, false}} {
		if !queue.incomplete {
			continue
		}
		urls := []string{}
		for _, p := range *queue.current {
			urls = append(urls, p.URL)
		}
		retained := 0
		for _, p := range queue.previous {
			e := entries[key(p.Repository)]
			if !tracked(p, e) || has(urls, p.URL) || has(result.ObservedURLs, p.URL) || has(result.Scope.ExcludeRepositories, p.Repository) {
				continue
			}
			internal := has(result.Scope.OwnedOwners, ownerOf(p.Repository))
			explicit := len(explicitSources(p, e.Sources)) > 0
			outgoing := (p.HeadRepository == "" || !strings.EqualFold(p.HeadRepository, p.Repository)) && (has(result.Scope.Authors, p.Author) || (p.HeadRepository != "" && (has(result.Scope.OwnedOwners, ownerOf(p.HeadRepository)) || has(result.Scope.LocalForks, p.HeadRepository))))
			if (queue.internal && !internal) || (!queue.internal && (internal || !(explicit || outgoing))) {
				continue
			}
			*queue.current = append(*queue.current, p)
			urls = append(urls, p.URL)
			retained++
		}
		if retained > 0 {
			name := "upstream"
			if queue.internal {
				name = "internal"
			}
			*warnings = append(*warnings, fmt.Sprintf("Incomplete %s coverage: retained %d previously scoped PRs; they may have changed since the last complete refresh.", name, retained))
		}
	}
}
func (s *Service) emit(record map[string]any) {
	if s.opts.Report == nil {
		return
	}
	defer func() { _ = recover() }()
	s.opts.Report(record)
}
