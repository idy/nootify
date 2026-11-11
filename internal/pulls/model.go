// Package pulls maintains GitHub pull requests subscribed through local agent sessions.
package pulls

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type PullReference struct {
	Repository string `json:"repository"`
	Number     int    `json:"number"`
	URL        string `json:"url"`
}
type SessionReference struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Agent   string `json:"agent"`
	Adapter string `json:"adapter"`
}
type RepositorySession struct {
	SessionReference
	Directory      string          `json:"directory"`
	Branch         string          `json:"branch,omitempty"`
	Archived       *bool           `json:"archived,omitempty"`
	LastActive     string          `json:"lastActive,omitempty"`
	FromRepository bool            `json:"fromRepository"`
	Pulls          []PullReference `json:"pulls"`
}
type CI struct {
	State   string `json:"state"`
	Passed  int    `json:"passed"`
	Failed  int    `json:"failed"`
	Pending int    `json:"pending"`
	Total   int    `json:"total"`
}
type PullRequest struct {
	Number         int                `json:"number"`
	URL            string             `json:"url"`
	Title          string             `json:"title"`
	IsDraft        bool               `json:"isDraft"`
	Repository     string             `json:"repository"`
	Author         string             `json:"author"`
	HeadRepository string             `json:"headRepository,omitempty"`
	HeadBranch     string             `json:"headBranch,omitempty"`
	UpdatedAt      string             `json:"updatedAt"`
	ReviewDecision string             `json:"reviewDecision"`
	Mergeable      string             `json:"mergeable"`
	CI             CI                 `json:"ci"`
	Sessions       []SessionReference `json:"sessions,omitempty"`
	Subscription   string             `json:"subscription,omitempty"`
}

// MarshalJSON preserves an explicitly empty sessions array for manual subscriptions.
// Cached, unassociated pulls omit the field just as the TypeScript cache does.
func (p PullRequest) MarshalJSON() ([]byte, error) {
	type plain PullRequest
	if p.Subscription == "" {
		return marshal(plain(p))
	}
	return marshal(struct {
		plain
		Sessions []SessionReference `json:"sessions"`
	}{plain(p), nonNil(p.Sessions)})
}

type PullCounts struct {
	Internal int `json:"internal"`
	Upstream int `json:"upstream"`
}
type RepositoryEntry struct {
	Repository  string              `json:"repository"`
	Followed    bool                `json:"followed"`
	Choice      string              `json:"choice,omitempty"`
	Agents      []string            `json:"agents"`
	Sessions    int                 `json:"sessions"`
	Sources     []RepositorySession `json:"sources"`
	AllPulls    bool                `json:"allPulls"`
	LinkedPulls int                 `json:"linkedPulls"`
	Authored    int                 `json:"authored"`
	LastActive  string              `json:"lastActive,omitempty"`
	Pulls       PullCounts          `json:"pulls"`
}
type RefreshState struct {
	Running       bool   `json:"running"`
	StartedAt     string `json:"startedAt,omitempty"`
	FinishedAt    string `json:"finishedAt,omitempty"`
	LastSuccessAt string `json:"lastSuccessAt,omitempty"`
	Error         string `json:"error,omitempty"`
	SignedOut     bool   `json:"signedOut,omitempty"`
}
type PullSnapshot struct {
	Internal     []PullRequest     `json:"internal"`
	Upstream     []PullRequest     `json:"upstream"`
	Hidden       PullCounts        `json:"hidden"`
	Repositories []RepositoryEntry `json:"repositories"`
	Refresh      RefreshState      `json:"refresh"`
	Warnings     []string          `json:"warnings"`
}
type Scope struct {
	Authors             []string `json:"authors"`
	OwnedOwners         []string `json:"ownedOwners"`
	ExcludeRepositories []string `json:"excludeRepositories"`
	LocalForks          []string `json:"localForks"`
}
type Target struct {
	Repository string `json:"repository"`
	Number     int    `json:"number"`
}
type Targets struct {
	Repositories []string `json:"repositories"`
	Pulls        []Target `json:"pulls"`
	LocalForks   []string `json:"localForks"`
}
type Collection struct {
	Internal           []PullRequest
	Upstream           []PullRequest
	Warnings           []string
	Scope              Scope
	IncompleteInternal bool
	IncompleteUpstream bool
	ObservedURLs       []string
}

var repoPattern = regexp.MustCompile(`(?i)^[a-z\d][a-z\d-]*/[a-z\d_.-]+$`)
var scpPattern = regexp.MustCompile(`(?i)^(?:[^@\s/:]+@)?github\.com:([^\s]+)$`)
var pullPattern = regexp.MustCompile(`^/([^/]+/[^/]+)/pull/(\d+)(?:/|$)`)

func key(s string) string          { return strings.ToLower(s) }
func ownerOf(s string) string      { return strings.SplitN(s, "/", 2)[0] }
func repositoryName(s string) bool { return ParseGitHubRemote("https://github.com/"+s) == s && s != "" }
func ParseGitHubRemote(value string) string {
	input := strings.TrimSpace(value)
	path := ""
	if m := scpPattern.FindStringSubmatch(input); m != nil {
		path = m[1]
	} else {
		u, err := url.Parse(input)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "ssh") || !strings.EqualFold(u.Hostname(), "github.com") {
			return ""
		}
		path = u.EscapedPath()
	}
	path = strings.Trim(path, "/")
	if strings.HasSuffix(key(path), ".git") {
		path = path[:len(path)-4]
	}
	if !repoPattern.MatchString(path) {
		return ""
	}
	n := strings.Split(path, "/")[1]
	if n == "." || n == ".." {
		return ""
	}
	return path
}
func ParseGitHubPull(value string) (PullReference, bool) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), "github.com") || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return PullReference{}, false
	}
	m := pullPattern.FindStringSubmatch(u.EscapedPath())
	if m == nil {
		return PullReference{}, false
	}
	repo := ParseGitHubRemote("https://github.com/" + m[1])
	n, err := strconv.ParseInt(m[2], 10, 64)
	if repo == "" || err != nil || n < 1 || n > 9007199254740991 {
		return PullReference{}, false
	}
	return PullReference{repo, int(n), fmt.Sprintf("https://github.com/%s/pull/%d", repo, n)}, true
}
func pullKey(repo string, n int) string { return fmt.Sprintf("%s#%d", key(repo), n) }
func has(values []string, s string) bool {
	for _, v := range values {
		if strings.EqualFold(v, s) {
			return true
		}
	}
	return false
}
func unique(values []string) []string {
	out := []string{}
	indices := map[string]int{}
	for _, v := range values {
		if i, ok := indices[key(v)]; ok {
			out[i] = v
		} else {
			indices[key(v)] = len(out)
			out = append(out, v)
		}
	}
	return out
}
func nonNil[T any](v []T) []T {
	if v == nil {
		return []T{}
	}
	return v
}
func nowISO() string          { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func validTime(s string) bool { _, e := time.Parse(time.RFC3339Nano, s); return e == nil }
func sortPulls(values []PullRequest) {
	sort.SliceStable(values, func(i, j int) bool {
		a, b := values[i], values[j]
		ta, ea := time.Parse(time.RFC3339Nano, a.UpdatedAt)
		tb, eb := time.Parse(time.RFC3339Nano, b.UpdatedAt)
		if (ea == nil) != (eb == nil) {
			return ea == nil
		}
		if ea == nil && !ta.Equal(tb) {
			return ta.Before(tb)
		}
		if key(a.Repository) != key(b.Repository) {
			return key(a.Repository) < key(b.Repository)
		}
		if a.Number != b.Number {
			return a.Number < b.Number
		}
		return a.URL < b.URL
	})
}

type githubPull struct {
	ID                string `json:"id"`
	Number            int    `json:"number"`
	URL               string `json:"url"`
	Title             string `json:"title"`
	State             string `json:"state"`
	IsDraft           bool   `json:"isDraft"`
	IsCrossRepository *bool  `json:"isCrossRepository"`
	UpdatedAt         string `json:"updatedAt"`
	Repository        struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
	Author *struct {
		Login string `json:"login"`
	} `json:"author"`
	HeadRepository *struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"headRepository"`
	HeadRefName    string `json:"headRefName"`
	ReviewDecision string `json:"reviewDecision"`
	Mergeable      string `json:"mergeable"`
	Commits        *struct {
		Nodes []*struct {
			Commit map[string]jsonRaw `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
	Reviews *struct {
		TotalCount int `json:"totalCount"`
		Nodes      []*struct {
			Author *struct {
				Login string `json:"login"`
			} `json:"author"`
			State       string `json:"state"`
			SubmittedAt string `json:"submittedAt"`
		} `json:"nodes"`
	} `json:"reviews"`
}

func classify(pr githubPull, scope Scope, linked bool) string {
	repo := pr.Repository.NameWithOwner
	if pr.State != "OPEN" || repo == "" || has(scope.ExcludeRepositories, repo) {
		return ""
	}
	if has(scope.OwnedOwners, ownerOf(repo)) {
		return "internal"
	}
	if linked {
		return "upstream"
	}
	head := ""
	if pr.HeadRepository != nil {
		head = pr.HeadRepository.NameWithOwner
	}
	if (pr.IsCrossRepository != nil && !*pr.IsCrossRepository) || (head != "" && strings.EqualFold(head, repo)) || (head == "" && (pr.IsCrossRepository == nil || !*pr.IsCrossRepository)) {
		return ""
	}
	author := ""
	if pr.Author != nil {
		author = pr.Author.Login
	}
	if has(scope.Authors, author) || (head != "" && (has(scope.OwnedOwners, ownerOf(head)) || has(scope.LocalForks, head))) {
		return "upstream"
	}
	return ""
}
func normalize(pr githubPull, warn func(string)) PullRequest {
	ci := CI{State: "UNKNOWN"}
	if pr.Commits != nil && len(pr.Commits.Nodes) > 0 {
		node := pr.Commits.Nodes[len(pr.Commits.Nodes)-1]
		if node != nil && node.Commit != nil {
			if raw, ok := node.Commit["statusCheckRollup"]; ok {
				if string(raw) == "null" {
					ci.State = "NONE"
				} else {
					var roll struct {
						State    string `json:"state"`
						Contexts *struct {
							TotalCount int `json:"totalCount"`
							Nodes      []*struct {
								Type       string `json:"__typename"`
								Status     string `json:"status"`
								Conclusion string `json:"conclusion"`
								State      string `json:"state"`
							} `json:"nodes"`
						} `json:"contexts"`
					}
					if unmarshal(raw, &roll) == nil && roll.Contexts != nil && roll.Contexts.Nodes != nil {
						count := 0
						for _, c := range roll.Contexts.Nodes {
							if c == nil {
								continue
							}
							count++
							if (c.Type == "CheckRun" && c.Status == "COMPLETED" && has([]string{"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}, c.Conclusion)) || (c.Type == "StatusContext" && has([]string{"FAILURE", "ERROR"}, c.State)) {
								ci.Failed++
							} else if (c.Type == "CheckRun" && c.Status == "COMPLETED" && has([]string{"SUCCESS", "NEUTRAL", "SKIPPED"}, c.Conclusion)) || (c.Type == "StatusContext" && c.State == "SUCCESS") {
								ci.Passed++
							} else {
								ci.Pending++
							}
						}
						ci.Total = max(roll.Contexts.TotalCount, count)
						ci.State = "NONE"
						if ci.Failed > 0 {
							ci.State = "FAILURE"
						} else if ci.Pending > 0 {
							ci.State = "PENDING"
						} else if ci.Passed > 0 {
							ci.State = "SUCCESS"
						}
						if ci.Total > count {
							switch roll.State {
							case "SUCCESS":
								ci.State = "SUCCESS"
							case "FAILURE", "ERROR":
								ci.State = "FAILURE"
							case "PENDING", "EXPECTED":
								ci.State = "PENDING"
							default:
								if ci.Failed > 0 {
									ci.State = "FAILURE"
								} else {
									ci.State = "UNKNOWN"
								}
							}
							warn(fmt.Sprintf("%s#%d: inspected %d of %d CI contexts; counts are partial and the aggregate determines CI state.", pr.Repository.NameWithOwner, pr.Number, count, ci.Total))
						}
					}
				}
			}
		}
	}
	decision := pr.ReviewDecision
	if decision == "" {
		decision = "UNKNOWN"
		if pr.Reviews != nil && pr.Reviews.Nodes != nil {
			type review struct{ state, date string }
			latest := map[string]review{}
			for _, r := range pr.Reviews.Nodes {
				if r == nil || r.Author == nil || r.Author.Login == "" || r.SubmittedAt == "" || r.State == "PENDING" {
					continue
				}
				id := key(r.Author.Login)
				p, ok := latest[id]
				if r.State == "COMMENTED" && ok && p.state != "COMMENTED" {
					continue
				}
				if !ok || (p.state == "COMMENTED" && r.State != "COMMENTED") || r.SubmittedAt >= p.date {
					latest[id] = review{r.State, r.SubmittedAt}
				}
			}
			decision = "REVIEW_REQUIRED"
			for _, r := range latest {
				if r.state == "CHANGES_REQUESTED" {
					decision = "CHANGES_REQUESTED"
					break
				}
				if r.state == "APPROVED" {
					decision = "APPROVED"
				}
			}
			if pr.Reviews.TotalCount > len(pr.Reviews.Nodes) {
				warn(fmt.Sprintf("%s#%d: only the latest 30 reviews were inspected; older reviewer decisions may be omitted.", pr.Repository.NameWithOwner, pr.Number))
			}
		}
	}
	author := "ghost"
	if pr.Author != nil && pr.Author.Login != "" {
		author = pr.Author.Login
	}
	merge := pr.Mergeable
	if merge == "" {
		merge = "UNKNOWN"
	}
	head := ""
	if pr.HeadRepository != nil {
		head = pr.HeadRepository.NameWithOwner
	}
	return PullRequest{Number: pr.Number, URL: pr.URL, Title: pr.Title, IsDraft: pr.IsDraft, Repository: pr.Repository.NameWithOwner, Author: author, HeadRepository: head, HeadBranch: pr.HeadRefName, UpdatedAt: pr.UpdatedAt, ReviewDecision: decision, Mergeable: merge, CI: ci}
}
