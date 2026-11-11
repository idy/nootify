package pulls

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type graphCall struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

func rawPull(n int, repo string) map[string]any {
	return map[string]any{"id": fmt.Sprintf("%s#%d", repo, n), "number": n, "url": fmt.Sprintf("https://github.com/%s/pull/%d", repo, n), "title": "Pull", "state": "OPEN", "isDraft": false, "isCrossRepository": true, "updatedAt": "2026-10-01T00:00:00Z", "author": map[string]any{"login": "viewer"}, "repository": map[string]any{"nameWithOwner": repo}, "headRepository": map[string]any{"nameWithOwner": "viewer/fork"}, "headRefName": "fix"}
}
func connectionFixture(nodes []any) map[string]any {
	return map[string]any{"nodes": nodes, "totalCount": len(nodes), "pageInfo": map[string]any{"hasNextPage": false, "endCursor": nil}}
}
func detailFixture(id any) map[string]any {
	return map[string]any{"id": id, "state": "OPEN", "updatedAt": "2026-10-01T00:00:00Z", "mergeable": "MERGEABLE", "reviewDecision": nil, "commits": map[string]any{"nodes": []any{map[string]any{"commit": map[string]any{"statusCheckRollup": nil}}}}, "reviews": map[string]any{"nodes": []any{}, "totalCount": 0}}
}
func TestTargetedGraphQLClassificationAndDetails(t *testing.T) {
	var mu sync.Mutex
	calls := []graphCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_test" || r.Header.Get("User-Agent") != "Nootify" {
			t.Error("missing headers")
		}
		var c graphCall
		if e := json.NewDecoder(r.Body).Decode(&c); e != nil {
			t.Error(e)
		}
		mu.Lock()
		calls = append(calls, c)
		mu.Unlock()
		reply := map[string]any{}
		switch {
		case strings.Contains(c.Query, "query PullViewer"):
			reply["viewer"] = map[string]any{"login": "viewer", "organizations": connectionFixture([]any{map[string]any{"login": "OurOrg"}, map[string]any{"login": "ExternalOrg"}})}
		case strings.Contains(c.Query, "query PullRepository"):
			repo := key(c.Variables["owner"].(string) + "/" + c.Variables["name"].(string))
			nodes := []any{}
			switch repo {
			case "viewer/session":
				nodes = []any{rawPull(1, repo)}
			case "external/project":
				other := rawPull(2, repo)
				other["author"] = map[string]any{"login": "stranger"}
				other["isCrossRepository"] = false
				other["headRepository"] = map[string]any{"nameWithOwner": repo}
				unrelated := rawPull(3, repo)
				unrelated["author"] = map[string]any{"login": "stranger"}
				unrelated["headRepository"] = map[string]any{"nameWithOwner": "stranger/fork"}
				local := rawPull(4, repo)
				local["author"] = map[string]any{"login": "colleague"}
				local["headRepository"] = map[string]any{"nameWithOwner": "local/fork"}
				nodes = []any{other, unrelated, local}
			}
			reply["repository"] = map[string]any{"pullRequests": connectionFixture(nodes)}
		case strings.Contains(c.Query, "query PullTarget"):
			repo := key(c.Variables["owner"].(string) + "/" + c.Variables["name"].(string))
			p := rawPull(int(c.Variables["number"].(float64)), repo)
			p["isCrossRepository"] = false
			p["author"] = map[string]any{"login": "stranger"}
			p["headRepository"] = map[string]any{"nameWithOwner": repo}
			reply["repository"] = map[string]any{"pullRequest": p}
		case strings.Contains(c.Query, "query PullDetails"):
			for k, id := range c.Variables {
				detail := detailFixture(id)
				if strings.Contains(id.(string), "viewer/session") {
					detail["mergeable"] = "CONFLICTING"
					detail["reviewDecision"] = "CHANGES_REQUESTED"
					detail["commits"] = map[string]any{"nodes": []any{map[string]any{"commit": map[string]any{"statusCheckRollup": map[string]any{"state": "FAILURE", "contexts": map[string]any{"totalCount": 104, "nodes": []any{map[string]any{"__typename": "StatusContext", "state": "ERROR"}, map[string]any{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED"}}}}}}}}
				}
				reply[strings.Replace(k, "id", "p", 1)] = detail
			}
		default:
			t.Errorf("unexpected broad query %s", c.Query)
		}
		jsonResponse(w, 200, map[string]any{"data": reply})
	}))
	defer server.Close()
	config, e := ParseConfig([]byte(`{"upstreamOwners":["ExternalOrg"],"ownedOwners":["ManualOrg"],"scanRoots":["/must-not-scan"],"followDefault":"all"}`), t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	c := newCommands(t.TempDir(), func() string { return "gho_test" }, defaultHTTPClient(nil), server.URL)
	result, e := collect(context.Background(), config, c, Targets{Repositories: []string{"viewer/session", "Viewer/Session", "external/project"}, Pulls: []Target{{"external/project", 2}, {"External/Project", 2}, {"elsewhere/direct", 77}}, LocalForks: []string{"local/fork"}})
	if e != nil {
		t.Fatal(e)
	}
	if len(result.Internal) != 1 || len(result.Upstream) != 3 || result.Internal[0].CI.State != "FAILURE" || result.Internal[0].CI.Passed != 1 || result.Internal[0].CI.Total != 104 || result.Internal[0].Mergeable != "CONFLICTING" {
		t.Fatalf("%+v", result)
	}
	if result.Upstream[0].Number != 77 || result.Upstream[1].Number != 2 || result.Upstream[2].Number != 4 {
		t.Fatal(result.Upstream)
	}
	if !has(result.Scope.OwnedOwners, "viewer") || !has(result.Scope.OwnedOwners, "OurOrg") || !has(result.Scope.OwnedOwners, "ManualOrg") || has(result.Scope.OwnedOwners, "ExternalOrg") {
		t.Fatal(result.Scope)
	}
	mu.Lock()
	defer mu.Unlock()
	repositories, links := 0, 0
	for _, call := range calls {
		if strings.Contains(call.Query, "search(") || strings.Contains(call.Query, "repositories(") {
			t.Fatal(call.Query)
		}
		if strings.Contains(call.Query, "query PullRepository") {
			repositories++
		}
		if strings.Contains(call.Query, "query PullTarget") {
			links++
		}
	}
	if repositories != 2 || links != 2 {
		t.Fatal(calls)
	}
}
func TestPaginationDetailsFailuresAndObservedClosed(t *testing.T) {
	for _, mode := range []string{"truncated", "invisible", "missing-details", "partial-details", "failed-details", "source-failed", "stuck-pagination", "observed-closed"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var c graphCall
				_ = json.NewDecoder(r.Body).Decode(&c)
				data := map[string]any{}
				reply := map[string]any{"data": data}
				switch {
				case strings.Contains(c.Query, "query PullViewer"):
					data["viewer"] = map[string]any{"login": "viewer", "organizations": connectionFixture([]any{})}
				case strings.Contains(c.Query, "query PullRepository"):
					connection := connectionFixture([]any{rawPull(1, "viewer/repo")})
					switch mode {
					case "truncated":
						connection["totalCount"] = 200
						connection["pageInfo"] = map[string]any{"hasNextPage": true, "endCursor": "next"}
					case "invisible":
						connection = connectionFixture([]any{rawPull(1, "viewer/repo"), nil})
					case "source-failed":
						data["repository"] = nil
						jsonResponse(w, 200, reply)
						return
					case "stuck-pagination":
						connection["pageInfo"] = map[string]any{"hasNextPage": true, "endCursor": nil}
					}
					data["repository"] = map[string]any{"pullRequests": connection}
				case strings.Contains(c.Query, "query PullTarget"):
					p := rawPull(1, "viewer/repo")
					p["state"] = "CLOSED"
					data["repository"] = map[string]any{"pullRequest": p}
				case strings.Contains(c.Query, "query PullDetails"):
					for k, id := range c.Variables {
						field := strings.Replace(k, "id", "p", 1)
						detail := detailFixture(id)
						switch mode {
						case "missing-details":
							delete(detail, "reviews")
						case "partial-details":
							reply["errors"] = []any{map[string]any{"message": "Checks permission denied", "path": []any{field, "commits"}}}
						case "failed-details":
							jsonResponse(w, 503, map[string]any{"message": "Details unavailable"})
							return
						}
						data[field] = detail
					}
				}
				jsonResponse(w, 200, reply)
			}))
			defer server.Close()
			config, _ := ParseConfig([]byte(`{"maxUpstreamPages":1}`), t.TempDir())
			c := newCommands(t.TempDir(), func() string { return "token" }, defaultHTTPClient(nil), server.URL)
			targets := Targets{Repositories: []string{"viewer/repo"}}
			if mode == "observed-closed" {
				targets.Pulls = []Target{{"viewer/repo", 1}}
			}
			result, e := collect(context.Background(), config, c, targets)
			if mode == "source-failed" || mode == "stuck-pagination" {
				var failure *CollectionError
				if !errors.As(e, &failure) || !strings.Contains(e.Error(), "source collection failed") {
					t.Fatal(result, e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if mode == "observed-closed" {
				if len(result.Internal) != 0 || len(result.ObservedURLs) != 1 {
					t.Fatal(result)
				}
				return
			}
			if len(result.Internal) != 1 {
				t.Fatal(result)
			}
			if mode == "truncated" || mode == "invisible" {
				if !result.IncompleteInternal || result.IncompleteUpstream {
					t.Fatal(result)
				}
			} else if result.Internal[0].CI.State != "UNKNOWN" || result.Internal[0].ReviewDecision != "UNKNOWN" {
				t.Fatal(result)
			}
			if len(result.Warnings) < 4 {
				t.Fatal(result.Warnings)
			}
		})
	}
}
func TestGraphQLConcurrencyAndCancellation(t *testing.T) {
	var mu sync.Mutex
	active, maximum, detailMaximum := 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var c graphCall
		_ = json.NewDecoder(r.Body).Decode(&c)
		mu.Lock()
		active++
		maximum = max(maximum, active)
		mu.Unlock()
		defer func() { mu.Lock(); active--; mu.Unlock() }()
		time.Sleep(2 * time.Millisecond)
		data := map[string]any{}
		switch {
		case strings.Contains(c.Query, "query PullViewer"):
			data["viewer"] = map[string]any{"login": "viewer", "organizations": connectionFixture([]any{})}
		case strings.Contains(c.Query, "query PullRepository"):
			repo := key(c.Variables["owner"].(string) + "/" + c.Variables["name"].(string))
			data["repository"] = map[string]any{"pullRequests": connectionFixture([]any{rawPull(1, repo), rawPull(2, repo), rawPull(3, repo)})}
		case strings.Contains(c.Query, "query PullDetails"):
			mu.Lock()
			detailMaximum = max(detailMaximum, len(c.Variables))
			mu.Unlock()
			for k, id := range c.Variables {
				data[strings.Replace(k, "id", "p", 1)] = detailFixture(id)
			}
		}
		jsonResponse(w, 200, map[string]any{"data": data})
	}))
	defer server.Close()
	config, _ := ParseConfig([]byte("{}"), t.TempDir())
	targets := Targets{}
	for i := 0; i < 12; i++ {
		targets.Repositories = append(targets.Repositories, fmt.Sprintf("viewer/repo%d", i))
	}
	c := newCommands(t.TempDir(), func() string { return "token" }, defaultHTTPClient(nil), server.URL)
	result, e := collect(context.Background(), config, c, targets)
	if e != nil || len(result.Internal) != 36 {
		t.Fatal(len(result.Internal), e)
	}
	mu.Lock()
	if maximum != 4 || detailMaximum > 8 {
		t.Fatal(maximum, detailMaximum)
	}
	mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e = collect(ctx, config, c, targets)
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}
func TestCommandsSignedOutPartialAndReadOnly(t *testing.T) {
	mode := "401"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch mode {
		case "401":
			jsonResponse(w, 401, map[string]any{"message": "Bad credentials"})
		case "403":
			jsonResponse(w, 403, map[string]any{"message": "API rate limit exceeded"})
		case "html":
			w.WriteHeader(502)
			fmt.Fprint(w, "bad gateway")
		case "partial":
			jsonResponse(w, 200, map[string]any{"data": map[string]any{"p0": nil}, "errors": []any{map[string]any{"message": "Could not resolve", "path": []any{"p0"}}}})
		}
	}))
	defer server.Close()
	c := newCommands(t.TempDir(), func() string { return "token" }, defaultHTTPClient(nil), server.URL)
	ctx := context.Background()
	query := "query Test { viewer { login } }"
	for _, value := range []string{"401", "403", "html", "partial"} {
		mode = value
		_, e := c.graphql(ctx, query, nil, false)
		if e == nil {
			t.Fatal(value)
		}
		if value == "401" && !errors.Is(e, ErrSignedOut) {
			t.Fatal(e)
		}
	}
	reply, e := c.graphql(ctx, query, nil, true)
	if e != nil || len(reply.Errors) != 1 {
		t.Fatal(reply, e)
	}
	if _, e = c.graphql(ctx, "mutation Change { viewer { login } }", nil, false); e == nil {
		t.Fatal("mutation allowed")
	}
}
func TestModelCIAndReviewFallback(t *testing.T) {
	raw := rawPull(1, "external/project")
	raw["reviews"] = map[string]any{"totalCount": 2, "nodes": []any{map[string]any{"author": map[string]any{"login": "reviewer"}, "state": "APPROVED", "submittedAt": "2026-10-01T00:00:00Z"}, map[string]any{"author": map[string]any{"login": "reviewer"}, "state": "COMMENTED", "submittedAt": "2026-10-02T00:00:00Z"}}}
	b, _ := json.Marshal(raw)
	pr, e := decodePull(b)
	if e != nil {
		t.Fatal(e)
	}
	p := normalize(pr, func(string) {})
	if p.ReviewDecision != "APPROVED" || p.CI.State != "UNKNOWN" || p.HeadBranch != "fix" {
		t.Fatal(p)
	}
	scope := Scope{Authors: []string{"viewer"}, OwnedOwners: []string{"viewer"}}
	if classify(pr, scope, false) != "upstream" {
		t.Fatal("outgoing missing")
	}
	pr.IsCrossRepository = boolptr(false)
	if classify(pr, scope, false) != "" || classify(pr, scope, true) != "upstream" {
		t.Fatal("explicit-link classification")
	}
	values := []PullRequest{testPull(9, "viewer/repo"), testPull(2, "viewer/repo"), testPull(1, "aaa/repo")}
	sortPulls(values)
	if !reflect.DeepEqual([]int{values[0].Number, values[1].Number, values[2].Number}, []int{1, 2, 9}) {
		t.Fatal(values)
	}
}
