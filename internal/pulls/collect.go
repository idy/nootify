package pulls

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

const baseFields = `id number url title state isDraft isCrossRepository headRefName updatedAt
 author { login } repository { nameWithOwner } headRepository { nameWithOwner }`
const detailFields = `id state updatedAt mergeable reviewDecision
 commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes {
 __typename ... on CheckRun { status conclusion } ... on StatusContext { state }
 } } } } } }
 reviews(last: 30) { totalCount nodes { author { login } state submittedAt } }`

type CollectionError struct {
	Message  string
	Warnings []string
}

func (e *CollectionError) Error() string { return e.Message }

type pageConnection struct {
	Nodes      []json.RawMessage `json:"nodes"`
	TotalCount *int              `json:"totalCount"`
	IssueCount *int              `json:"issueCount"`
	PageInfo   *struct {
		HasNextPage *bool   `json:"hasNextPage"`
		EndCursor   *string `json:"endCursor"`
	} `json:"pageInfo"`
}

func nested(data map[string]json.RawMessage, names ...string) json.RawMessage {
	var raw json.RawMessage
	for index, name := range names {
		raw = data[name]
		if index < len(names)-1 {
			var next map[string]json.RawMessage
			_ = json.Unmarshal(raw, &next)
			data = next
		}
	}
	return raw
}
func paginated(ctx context.Context, source string, maximum int, fetch func(any) (json.RawMessage, error)) ([]json.RawMessage, bool, []string, error) {
	nodes := []json.RawMessage{}
	warnings := []string{}
	var cursor any
	scanned, total := 0, 0
	incomplete := false
	for index := 0; index < maximum; index++ {
		if ctx.Err() != nil {
			return nil, false, warnings, ctx.Err()
		}
		raw, e := fetch(cursor)
		if e != nil {
			return nil, false, warnings, e
		}
		var connection pageConnection
		if json.Unmarshal(raw, &connection) != nil || connection.Nodes == nil || connection.PageInfo == nil || connection.PageInfo.HasNextPage == nil || (connection.TotalCount == nil && connection.IssueCount == nil) {
			return nil, false, warnings, fmt.Errorf("GitHub omitted the %s connection; check account permissions.", source)
		}
		n := 0
		if connection.TotalCount != nil {
			n = *connection.TotalCount
		} else {
			n = *connection.IssueCount
		}
		total = max(total, n)
		scanned += len(connection.Nodes)
		for _, node := range connection.Nodes {
			if string(node) == "null" {
				incomplete = true
				warnings = append(warnings, source+": a node was not visible; source coverage is incomplete.")
				continue
			}
			nodes = append(nodes, node)
		}
		if !*connection.PageInfo.HasNextPage {
			if total > scanned {
				incomplete = true
				warnings = append(warnings, fmt.Sprintf("%s: inspected %d of %d records; the list changed or inaccessible records were omitted.", source, scanned, total))
			}
			return nodes, incomplete, warnings, nil
		}
		if connection.PageInfo.EndCursor == nil || *connection.PageInfo.EndCursor == "" || *connection.PageInfo.EndCursor == cursor {
			return nil, false, warnings, fmt.Errorf("%s: GitHub pagination did not advance.", source)
		}
		cursor = *connection.PageInfo.EndCursor
	}
	warnings = append(warnings, fmt.Sprintf("%s: truncated at %d of %d records (%d pages).", source, scanned, total, maximum))
	return nodes, true, warnings, nil
}
func parallelTasks[T any](ctx context.Context, tasks []func() (T, error)) ([]T, []error) {
	out := make([]T, len(tasks))
	errs := make([]error, len(tasks))
	var wg sync.WaitGroup
	jobs := make(chan int)
	workers := min(4, len(tasks))
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				if ctx.Err() != nil {
					errs[i] = ctx.Err()
					continue
				}
				out[i], errs[i] = tasks[i]()
			}
		}()
	}
	for i := range tasks {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return out, errs
}
func collect(ctx context.Context, config Config, c *commands, targets Targets) (Collection, error) {
	warnings := []string{}
	warn := func(s string) { warnings = append(warnings, safeError(errors.New(s))) }
	incompleteInternal, incompleteUpstream := false, false
	owners := []string{}
	viewer := ""
	orgs, incomplete, ws, e := paginated(ctx, "organizations", 10, func(cursor any) (json.RawMessage, error) {
		reply, e := c.graphql(ctx, `query PullViewer($cursor: String) {
 viewer { login organizations(first: 100, after: $cursor) { totalCount nodes { login } pageInfo { hasNextPage endCursor } } }
 }`, map[string]any{"cursor": cursor}, false)
		if e != nil {
			return nil, e
		}
		var v struct {
			Login         string          `json:"login"`
			Organizations json.RawMessage `json:"organizations"`
		}
		if json.Unmarshal(reply.Data["viewer"], &v) != nil || v.Login == "" {
			return nil, errors.New("GitHub did not return the authenticated viewer.")
		}
		viewer = v.Login
		return v.Organizations, nil
	})
	warnings = append(warnings, ws...)
	if e != nil {
		if ctx.Err() != nil {
			return Collection{}, ctx.Err()
		}
		if errors.Is(e, ErrSignedOut) {
			return Collection{}, e
		}
		return Collection{}, &CollectionError{"Cannot establish GitHub viewer and internal organizations: " + safeError(e), uniqueExact(warnings)}
	}
	incompleteInternal = incomplete
	incompleteUpstream = incomplete
	for _, org := range orgs {
		var value struct {
			Login string `json:"login"`
		}
		if json.Unmarshal(org, &value) == nil && !has(config.UpstreamOwners, value.Login) {
			owners = append(owners, value.Login)
		}
	}
	owners = unique(append(owners, viewer))
	for _, owner := range config.OwnedOwners {
		if !has(owners, owner) {
			owners = append(owners, owner)
		}
	}
	scope := Scope{Authors: unique(append([]string{viewer}, config.Authors...)), OwnedOwners: owners, ExcludeRepositories: config.ExcludeRepositories, LocalForks: unique(targets.LocalForks)}
	type sourceResult struct {
		pulls      []githubPull
		incomplete bool
		warnings   []string
		linked     bool
		repository string
		name       string
	}
	tasks := []func() (sourceResult, error){}
	names := []string{}
	for _, repo := range unique(targets.Repositories) {
		if has(scope.ExcludeRepositories, repo) {
			continue
		}
		repo := repo
		source := "repository:" + repo
		names = append(names, source)
		tasks = append(tasks, func() (sourceResult, error) {
			parts := strings.SplitN(repo, "/", 2)
			if len(parts) != 2 {
				return sourceResult{}, errors.New("Expected an owner/name GitHub repository")
			}
			nodes, inc, warnings, e := paginated(ctx, source, config.MaxUpstreamPages, func(cursor any) (json.RawMessage, error) {
				reply, e := c.graphql(ctx, `query PullRepository($owner: String!, $name: String!, $cursor: String) {
 repository(owner: $owner, name: $name) { pullRequests(states: [OPEN], first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: ASC}) {
 totalCount nodes { `+baseFields+` } pageInfo { hasNextPage endCursor }
 } }
 }`, map[string]any{"owner": parts[0], "name": parts[1], "cursor": cursor}, false)
				if e != nil {
					return nil, e
				}
				return nested(reply.Data, "repository", "pullRequests"), nil
			})
			r := sourceResult{incomplete: inc, warnings: warnings, repository: repo, name: source}
			if e != nil {
				return r, e
			}
			for _, raw := range nodes {
				p, e := decodePull(raw)
				if e != nil {
					return r, e
				}
				r.pulls = append(r.pulls, p)
			}
			return r, nil
		})
	}
	seenTargets := map[string]int{}
	links := []Target{}
	for _, p := range targets.Pulls {
		if has(scope.ExcludeRepositories, p.Repository) {
			continue
		}
		k := pullKey(p.Repository, p.Number)
		if i, ok := seenTargets[k]; ok {
			links[i] = p
		} else {
			seenTargets[k] = len(links)
			links = append(links, p)
		}
	}
	for _, p := range links {
		p := p
		source := fmt.Sprintf("pull:%s#%d", p.Repository, p.Number)
		names = append(names, source)
		tasks = append(tasks, func() (sourceResult, error) {
			parts := strings.SplitN(p.Repository, "/", 2)
			r := sourceResult{linked: true, repository: p.Repository, name: source}
			if len(parts) != 2 {
				return r, errors.New("Expected an owner/name GitHub repository")
			}
			reply, e := c.graphql(ctx, `query PullTarget($owner: String!, $name: String!, $number: Int!) {
 repository(owner: $owner, name: $name) { pullRequest(number: $number) { `+baseFields+` } }
 }`, map[string]any{"owner": parts[0], "name": parts[1], "number": p.Number}, false)
			if e != nil {
				return r, e
			}
			raw := nested(reply.Data, "repository", "pullRequest")
			if len(raw) == 0 || string(raw) == "null" {
				return r, errors.New("Linked pull request is inaccessible to the current account.")
			}
			pr, e := decodePull(raw)
			if e != nil {
				return r, e
			}
			r.pulls = []githubPull{pr}
			return r, nil
		})
	}
	results, errs := parallelTasks(ctx, tasks)
	if ctx.Err() != nil {
		return Collection{}, ctx.Err()
	}
	failures := []string{}
	for i, r := range results {
		warnings = append(warnings, r.warnings...)
		if errs[i] != nil {
			msg := names[i] + ": " + safeError(errs[i])
			failures = append(failures, msg)
			warn(msg + " Coverage for this source failed; the last good snapshot is retained.")
		}
	}
	if len(failures) > 0 {
		return Collection{}, &CollectionError{"GitHub source collection failed: " + strings.Join(failures, "; "), uniqueExact(warnings)}
	}
	retained := map[string]githubPull{}
	order := []string{}
	observed := []string{}
	linked := map[string]bool{}
	for _, r := range results {
		if r.incomplete {
			if has(scope.OwnedOwners, ownerOf(r.repository)) {
				incompleteInternal = true
			} else {
				incompleteUpstream = true
			}
		}
		for _, pr := range r.pulls {
			u := key(pr.URL)
			observed = append(observed, u)
			if r.linked {
				linked[u] = true
			} else if linked[u] {
				continue
			}
			previous, ok := retained[u]
			if r.linked || !ok || pr.UpdatedAt >= previous.UpdatedAt {
				if classify(pr, scope, linked[u]) != "" {
					if !ok {
						order = append(order, u)
					}
					retained[u] = pr
				} else {
					delete(retained, u)
				}
			}
		}
	}
	entries := []githubPull{}
	seenEntries := map[string]bool{}
	for _, u := range order {
		if pr, ok := retained[u]; ok && !seenEntries[u] {
			entries = append(entries, pr)
			seenEntries[u] = true
		}
	}
	type detailResult struct {
		reply      graphReply
		start, end int
	}
	details := []func() (detailResult, error){}
	for offset := 0; offset < len(entries); offset += 8 {
		start, end := offset, min(offset+8, len(entries))
		details = append(details, func() (detailResult, error) {
			definitions, fields := []string{}, []string{}
			variables := map[string]any{}
			for i := start; i < end; i++ {
				n := i - start
				definitions = append(definitions, fmt.Sprintf("$id%d: ID!", n))
				fields = append(fields, fmt.Sprintf("p%d: node(id: $id%d) { ... on PullRequest { %s } }", n, n, detailFields))
				variables[fmt.Sprintf("id%d", n)] = entries[i].ID
			}
			reply, e := c.graphql(ctx, "query PullDetails("+strings.Join(definitions, ", ")+") { "+strings.Join(fields, "\n")+" }", variables, true)
			return detailResult{reply, start, end}, e
		})
	}
	detailResults, detailErrs := parallelTasks(ctx, details)
	if ctx.Err() != nil {
		return Collection{}, ctx.Err()
	}
	for i, r := range detailResults {
		if e := detailErrs[i]; e != nil {
			warn(fmt.Sprintf("details: %d PRs have UNKNOWN review/merge/CI values: %s", r.end-r.start, safeError(e)))
			continue
		}
		for j := r.start; j < r.end; j++ {
			pr := &entries[j]
			field := fmt.Sprintf("p%d", j-r.start)
			raw := r.reply.Data[field]
			var detail map[string]json.RawMessage
			_ = json.Unmarshal(raw, &detail)
			var id, state string
			_ = json.Unmarshal(detail["id"], &id)
			_ = json.Unmarshal(detail["state"], &state)
			if id == pr.ID && has([]string{"OPEN", "CLOSED", "MERGED"}, state) {
				pr.State = state
			}
			missing := []string{}
			for _, f := range []string{"mergeable", "reviewDecision", "commits", "reviews"} {
				if _, ok := detail[f]; !ok {
					missing = append(missing, f)
				}
			}
			messages := []string{}
			for _, e := range r.reply.Errors {
				if len(e.Path) == 0 || e.Path[0] == field {
					messages = append(messages, e.Message)
				}
			}
			if id != pr.ID || len(messages) > 0 || len(missing) > 0 {
				msg := fmt.Sprintf("%s#%d: review/merge/CI details unavailable; values are UNKNOWN. %s", pr.Repository.NameWithOwner, pr.Number, strings.Join(messages, "; "))
				if len(missing) > 0 {
					msg += " Missing fields: " + strings.Join(missing, ", ") + "."
				}
				warn(msg)
				continue
			}
			base, _ := json.Marshal(pr)
			var merged map[string]json.RawMessage
			_ = json.Unmarshal(base, &merged)
			for k, v := range detail {
				merged[k] = v
			}
			updated, _ := json.Marshal(merged)
			_ = json.Unmarshal(updated, pr)
		}
	}
	result := Collection{Internal: []PullRequest{}, Upstream: []PullRequest{}, Scope: scope, IncompleteInternal: incompleteInternal, IncompleteUpstream: incompleteUpstream, ObservedURLs: uniqueExact(observed)}
	for _, p := range entries {
		switch classify(p, scope, linked[key(p.URL)]) {
		case "internal":
			result.Internal = append(result.Internal, normalize(p, warn))
		case "upstream":
			result.Upstream = append(result.Upstream, normalize(p, warn))
		}
	}
	sortedOwners := append([]string{}, scope.OwnedOwners...)
	sort.Strings(sortedOwners)
	warn(fmt.Sprintf("Source coverage: GitHub account %s; internal owners: %s; outgoing authors: %s plus owned/local forks.", viewer, strings.Join(sortedOwners, ", "), strings.Join(scope.Authors, ", ")))
	warn("Only targeted github.com repositories and linked PRs visible to the signed-in GitHub account are covered; private repositories and organization SSO depend on its permissions.")
	warn("Organization memberships count as internal unless listed in upstreamOwners; explicit ownedOwners takes precedence. Linked open PRs are followed regardless of author or fork.")
	result.Warnings = uniqueExact(warnings)
	sort.Strings(result.Warnings)
	sortPulls(result.Internal)
	sortPulls(result.Upstream)
	return result, nil
}
func decodePull(raw json.RawMessage) (githubPull, error) {
	var p githubPull
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &p) != nil || json.Unmarshal(raw, &fields) != nil || p.ID == "" || p.URL == "" || !jsonString(fields["title"]) || p.Repository.NameWithOwner == "" || p.State == "" || !jsonString(fields["updatedAt"]) || p.Number < 1 {
		return p, errors.New("GitHub returned an incomplete pull request.")
	}
	return p, nil
}
