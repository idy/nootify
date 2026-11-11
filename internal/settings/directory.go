package settings

import (
	"context"
	"errors"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type Recipient struct {
	OpenID    string `json:"open_id"`
	Name      string `json:"name"`
	EnName    string `json:"en_name,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
	AvatarURL string `json:"avatar_url,omitempty"`
}
type Directory struct {
	AppID             string      `json:"app_id"`
	Users             []Recipient `json:"users"`
	Truncated         bool        `json:"truncated"`
	PermissionLimited bool        `json:"permission_limited"`
	Permission        *Permission `json:"permission,omitempty"`
	Cached            bool        `json:"cached,omitempty"`
	FetchedAt         int64       `json:"fetched_at,omitempty"`
	RefreshAfter      int64       `json:"refresh_after"`
	ExpiresAt         int64       `json:"expires_at,omitempty"`
}

const directoryFresh = 15 * time.Minute
const directoryMaxAge = 24 * time.Hour

func trim(s string) string { return strings.TrimSpace(s) }
func avatarURL(s string) string {
	if len(s) > 4096 || s != trim(s) {
		return ""
	}
	u, e := url.Parse(s)
	if e == nil && u.Scheme == "https" && strings.HasSuffix(u.Hostname(), ".feishucdn.com") && u.Port() == "" && u.User == nil {
		return s
	}
	return ""
}
func mergeUsers(cached, incoming []Recipient) []Recipient {
	out := append([]Recipient{}, cached...)
	index := map[string]int{}
	for i, v := range out {
		index[v.OpenID] = i
	}
	for _, v := range incoming {
		if i, ok := index[v.OpenID]; ok {
			out[i] = v
		} else {
			index[v.OpenID] = len(out)
			out = append(out, v)
		}
	}
	return out
}
func cloneDirectory(d Directory) Directory {
	d.Users = append([]Recipient{}, d.Users...)
	if d.Permission != nil {
		p := *d.Permission
		p.Scopes = append([]string{}, p.Scopes...)
		d.Permission = &p
	}
	return d
}
func (s *Service) Recipients(ctx context.Context, progress func(Directory), refresh bool) (Directory, error) {
	c, e := s.compatibility(ctx)
	if e != nil {
		return Directory{}, e
	}
	creds := c.credentials()
	if creds.AppID == "" || creds.AppSecret == "" {
		return Directory{}, problem(409, "Configure the Feishu application first")
	}
	check := func() error {
		if ctx.Err() != nil {
			return problem(499, "Directory request cancelled")
		}
		next, e := s.compatibility(ctx)
		if e != nil {
			return e
		}
		if next.credentials() != creds {
			return problem(409, "Feishu credentials changed; reload the directory")
		}
		return nil
	}
	if e = check(); e != nil {
		return Directory{}, e
	}
	cached := s.cache.read(creds)
	if e = check(); e != nil {
		return Directory{}, e
	}
	decorate := func(d Directory) (Directory, error) {
		d = cloneDirectory(d)
		if d.Permission != nil || d.PermissionLimited {
			var e error
			d.Permission, e = s.permissionHelp(creds.AppID, d.Permission, false)
			if e != nil {
				return d, e
			}
		}
		return d, nil
	}
	stamp := func(d Directory, at int64, cached bool) Directory {
		d.Cached = cached
		d.FetchedAt = at
		d.RefreshAfter = at + directoryFresh.Milliseconds()
		if d.Truncated {
			d.RefreshAfter = 0
		}
		d.ExpiresAt = at + directoryMaxAge.Milliseconds()
		return d
	}
	if cached != nil {
		d, e := decorate(cached.Directory)
		if e != nil {
			return Directory{}, e
		}
		d = stamp(d, cached.At, true)
		if e = check(); e != nil {
			return Directory{}, e
		}
		if progress != nil {
			progress(d)
		}
		if !refresh && !cached.Directory.Truncated && s.now().UnixMilli()-cached.At < directoryFresh.Milliseconds() {
			return d, nil
		}
	}
	s.mu.Lock()
	s.refresh++
	id := s.refresh
	s.mu.Unlock()
	var progressErr error
	publish := func(d Directory) {
		if progress == nil || progressErr != nil {
			return
		}
		if e := check(); e != nil {
			progressErr = e
			return
		}
		d, e := decorate(d)
		if e != nil {
			progressErr = e
			return
		}
		if cached != nil {
			d.Users = mergeUsers(cached.Directory.Users, d.Users)
			d = stamp(d, cached.At, true)
		}
		if e = check(); e != nil {
			progressErr = e
			return
		}
		progress(d)
	}
	d, e := s.fetchDirectory(ctx, s.api(creds), publish)
	if ce := check(); ce != nil {
		return Directory{}, ce
	}
	if progressErr != nil {
		return Directory{}, progressErr
	}
	if e != nil {
		var pe *apiError
		if errors.As(e, &pe) && permissionCode(pe.code) {
			s.mu.Lock()
			if id == s.refresh {
				s.cache.clear()
			}
			s.mu.Unlock()
			help, he := s.permissionHelp(creds.AppID, pe.permission, false)
			if he != nil {
				return Directory{}, he
			}
			return Directory{}, &Error{Status: 403, Message: "Feishu application permissions or contact access range are required", Permission: help}
		}
		return Directory{}, e
	}
	keep := cached != nil && d.Truncated && !d.PermissionLimited
	at := s.now().UnixMilli()
	if keep {
		d.Users = mergeUsers(cached.Directory.Users, d.Users)
		at = cached.At
	}
	out, e := decorate(d)
	if e != nil {
		return Directory{}, e
	}
	out = stamp(out, at, keep)
	if e = check(); e != nil {
		return Directory{}, e
	}
	s.mu.Lock()
	if id == s.refresh {
		s.cache.write(creds, d, at)
	}
	s.mu.Unlock()
	if e = check(); e != nil {
		return Directory{}, e
	}
	return out, nil
}

type directoryReader struct {
	api                *larkAPI
	ctx                context.Context
	mu                 sync.Mutex
	publishMu          sync.Mutex
	users              map[string]Recipient
	expanded           map[string]bool
	requests           int
	truncated, limited bool
	permission         *Permission
	progress           func(Directory)
	finished           bool
	semaphore          chan struct{}
}

func (r *directoryReader) snapshot() Directory {
	r.mu.Lock()
	defer r.mu.Unlock()
	d := Directory{AppID: r.api.credentials.AppID, Users: []Recipient{}, Truncated: r.truncated, PermissionLimited: r.limited, Permission: r.permission}
	for _, v := range r.users {
		d.Users = append(d.Users, v)
	}
	sort.Slice(d.Users, func(i, j int) bool {
		if d.Users[i].Name == d.Users[j].Name {
			return d.Users[i].OpenID < d.Users[j].OpenID
		}
		return d.Users[i].Name < d.Users[j].Name
	})
	return cloneDirectory(d)
}
func (r *directoryReader) publish() {
	if r.progress == nil || r.ctx.Err() != nil {
		return
	}
	r.publishMu.Lock()
	defer r.publishMu.Unlock()
	r.mu.Lock()
	done := r.finished
	r.mu.Unlock()
	if !done && r.ctx.Err() == nil {
		r.progress(r.snapshot())
	}
}
func (r *directoryReader) add(items []any) {
	r.mu.Lock()
	changed := false
	for _, item := range items {
		u := object(item)
		id := text(u["open_id"])
		status := object(u["status"])
		if !openPattern.MatchString(id) || status["is_frozen"] == true || status["is_resigned"] == true || status["is_exited"] == true || status["is_unjoin"] == true {
			continue
		}
		if _, exists := r.users[id]; !exists && len(r.users) >= 5000 {
			r.truncated = true
			break
		}
		name := trim(text(u["name"]))
		if name == "" {
			name = trim(text(u["nickname"]))
		}
		if name == "" {
			name = trim(text(u["en_name"]))
		}
		if name == "" {
			name = id
		}
		v := Recipient{OpenID: id, Name: name, EnName: trim(text(u["en_name"])), Nickname: trim(text(u["nickname"]))}
		for _, key := range []string{"avatar_72", "avatar_240", "avatar_640", "avatar_origin"} {
			if a := avatarURL(text(object(u["avatar"])[key])); a != "" {
				v.AvatarURL = a
				break
			}
		}
		if r.users[id] != v {
			r.users[id] = v
			changed = true
		}
	}
	r.mu.Unlock()
	if changed {
		r.publish()
	}
}
func (r *directoryReader) request(path string) (map[string]any, error) {
	select {
	case r.semaphore <- struct{}{}:
	case <-r.ctx.Done():
		return nil, r.ctx.Err()
	}
	defer func() { <-r.semaphore }()
	r.mu.Lock()
	if r.requests >= 100 || len(r.users) >= 5000 {
		r.truncated = true
		r.mu.Unlock()
		return nil, nil
	}
	r.requests++
	r.mu.Unlock()
	return r.api.request(r.ctx, path)
}
func (r *directoryReader) pages(path string, read func(map[string]any)) error {
	seen := map[string]bool{}
	token := ""
	for {
		p := path
		if token != "" {
			p += "&page_token=" + url.QueryEscape(token)
		}
		page, e := r.request(p)
		if e != nil {
			return e
		}
		if page == nil {
			return nil
		}
		if r.ctx.Err() != nil {
			return r.ctx.Err()
		}
		read(page)
		if page["has_more"] != true {
			return nil
		}
		token = text(page["page_token"])
		if token == "" || seen[token] {
			return errors.New("Invalid Feishu directory pagination")
		}
		seen[token] = true
	}
}
func (r *directoryReader) readable(f func() error) error {
	e := f()
	var pe *apiError
	if errors.As(e, &pe) && permissionCode(pe.code) {
		r.mu.Lock()
		r.limited = true
		if r.permission == nil && pe.permission != nil {
			r.permission = pe.permission
		}
		r.mu.Unlock()
		r.publish()
		return nil
	}
	return e
}
func (r *directoryReader) profiles(ids []string) error {
	jobs := []func() error{}
	for offset := 0; offset < len(ids); offset += 50 {
		batch := append([]string{}, ids[offset:min(offset+50, len(ids))]...)
		jobs = append(jobs, func() error {
			q := url.Values{"user_id_type": {"open_id"}}
			for _, id := range batch {
				if openPattern.MatchString(id) {
					q.Add("user_ids", id)
				}
			}
			return r.readable(func() error {
				p, e := r.request("/open-apis/contact/v3/users/batch?" + q.Encode())
				if e == nil {
					r.add(array(p["items"]))
				}
				return e
			})
		})
	}
	return parallelJobs(r.ctx, jobs)
}
func (r *directoryReader) department(id string) error {
	r.mu.Lock()
	if r.expanded[id] {
		r.mu.Unlock()
		return nil
	}
	r.expanded[id] = true
	r.mu.Unlock()
	readUsers := func(id string) error {
		return r.readable(func() error {
			return r.pages("/open-apis/contact/v3/users/find_by_department?department_id="+url.QueryEscape(id)+"&department_id_type=open_department_id&user_id_type=open_id&page_size=50", func(p map[string]any) { r.add(array(p["items"])) })
		})
	}
	descendants := []string{}
	e := r.readable(func() error {
		return r.pages("/open-apis/contact/v3/departments/"+url.PathEscape(id)+"/children?department_id_type=open_department_id&fetch_child=true&page_size=50", func(p map[string]any) {
			for _, v := range array(p["items"]) {
				if id := text(object(v)["open_department_id"]); id != "" && len(descendants) < 100 {
					descendants = append(descendants, id)
				}
			}
		})
	})
	if e != nil {
		return e
	}
	if e = readUsers(id); e != nil {
		return e
	}
	for _, id := range descendants {
		r.mu.Lock()
		known := r.expanded[id]
		r.expanded[id] = true
		r.mu.Unlock()
		if !known {
			if e = readUsers(id); e != nil {
				return e
			}
		}
	}
	return nil
}
func parallelJobs(ctx context.Context, jobs []func() error) error {
	if len(jobs) == 0 {
		return nil
	}
	var mu sync.Mutex
	next := 0
	var first error
	var wg sync.WaitGroup
	for i := 0; i < min(4, len(jobs)); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if next >= len(jobs) || first != nil || ctx.Err() != nil {
					mu.Unlock()
					return
				}
				f := jobs[next]
				next++
				mu.Unlock()
				if e := f(); e != nil {
					mu.Lock()
					if first == nil {
						first = e
					}
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return first
}
func (s *Service) fetchDirectory(ctx context.Context, api *larkAPI, progress func(Directory)) (Directory, error) {
	deadline, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	r := &directoryReader{api: api, ctx: deadline, users: map[string]Recipient{}, expanded: map[string]bool{}, progress: progress, semaphore: make(chan struct{}, 4)}
	users, depts, groups := []string{}, []string{}, []string{}
	unique := func(dst *[]string, v any) {
		seen := map[string]bool{}
		for _, s := range *dst {
			seen[s] = true
		}
		for _, x := range array(v) {
			if s := text(x); s != "" && !seen[s] && len(*dst) < 5000 {
				seen[s] = true
				*dst = append(*dst, s)
			}
		}
	}
	e := r.pages("/open-apis/contact/v3/scopes?user_id_type=open_id&department_id_type=open_department_id&page_size=100", func(p map[string]any) {
		unique(&users, p["user_ids"])
		unique(&depts, p["department_ids"])
		unique(&groups, p["group_ids"])
	})
	if e == nil {
		jobs := []func() error{func() error { return r.profiles(users) }}
		for _, id := range depts {
			jobs = append(jobs, func() error { return r.department(id) })
		}
		e = parallelJobs(deadline, jobs)
	}
	if e == nil {
		for _, id := range groups {
			memberUsers, memberDepts := []string{}, []string{}
			for _, kind := range []string{"user", "department"} {
				e = r.readable(func() error {
					return r.pages("/open-apis/contact/v3/group/"+url.PathEscape(id)+"/member/simplelist?member_type="+kind+"&member_id_type=open_id&page_size=100", func(p map[string]any) {
						for _, v := range array(p["memberlist"]) {
							m := object(v)
							if text(m["member_type"]) != kind {
								continue
							}
							id := text(m["member_id"])
							if kind == "user" {
								memberUsers = append(memberUsers, id)
							} else {
								memberDepts = append(memberDepts, id)
							}
						}
					})
				})
				if e != nil {
					break
				}
			}
			if e != nil {
				break
			}
			if e = r.profiles(memberUsers); e != nil {
				break
			}
			for _, id := range memberDepts {
				if e = r.department(id); e != nil {
					break
				}
			}
			if e != nil {
				break
			}
		}
	}
	r.mu.Lock()
	r.finished = true
	r.mu.Unlock()
	d := r.snapshot()
	if ctx.Err() != nil {
		return Directory{}, problem(499, "Directory request cancelled")
	}
	if e != nil {
		var pe *apiError
		if errors.As(e, &pe) && permissionCode(pe.code) {
			d.PermissionLimited = true
			d.Permission = pe.permission
			if len(d.Users) == 0 {
				return Directory{}, pe
			}
		} else if deadline.Err() != nil {
			if len(d.Users) == 0 {
				return Directory{}, problem(504, "Feishu directory request timed out")
			}
			d.Truncated = true
		} else {
			return Directory{}, problem(502, "Could not read the Feishu directory")
		}
	}
	if len(d.Users) == 0 && d.PermissionLimited {
		return Directory{}, &apiError{99991672, d.Permission}
	}
	return d, nil
}
