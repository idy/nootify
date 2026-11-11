package pulls

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const DefaultGitHubClientID = "Ov23liMl1ElZD0hh84y1"

type GitHubAccount struct {
	SignedIn bool   `json:"signedIn"`
	Login    string `json:"login,omitempty"`
	Error    string `json:"error,omitempty"`
}
type GitHubLogin struct {
	Status    string `json:"status"`
	Code      string `json:"code,omitempty"`
	URL       string `json:"url,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	Error     string `json:"error,omitempty"`
}
type GitHubSettings struct {
	Account GitHubAccount `json:"account"`
	Login   GitHubLogin   `json:"login"`
}
type AuthOptions struct {
	GetToken   func() string
	SetToken   func(string) error
	Report     func(map[string]any)
	Changed    func()
	ClientID   string
	HTTPClient *http.Client
	GraphQLURL string
	// GitHubURL defaults to https://github.com; overriding is useful for an isolated device-flow fixture.
	GitHubURL string
	StateDir  string
}

// Auth uses Nootify's own OAuth device flow. It never changes the gh CLI's independent credentials.
type Auth struct {
	opts        AuthOptions
	mu          sync.Mutex
	tokenWrites sync.Mutex
	flow        GitHubLogin
	cancel      context.CancelFunc
	generation  uint64
	closed      bool
	wg          sync.WaitGroup
}

func NewAuth(opts AuthOptions) *Auth {
	if opts.ClientID == "" {
		opts.ClientID = strings.TrimSpace(os.Getenv("NOOTIFY_GITHUB_CLIENT_ID"))
		if opts.ClientID == "" {
			opts.ClientID = DefaultGitHubClientID
		}
	}
	if opts.GraphQLURL == "" {
		opts.GraphQLURL = defaultGraphQLURL
	}
	if opts.GitHubURL == "" {
		opts.GitHubURL = "https://github.com"
	}
	opts.HTTPClient = defaultHTTPClient(opts.HTTPClient)
	if opts.GetToken == nil {
		opts.GetToken = func() string { return "" }
	}
	return &Auth{opts: opts, flow: GitHubLogin{Status: "idle"}}
}
func (a *Auth) Login() GitHubLogin { a.mu.Lock(); defer a.mu.Unlock(); return a.flow }
func optionalContext(contexts []context.Context) context.Context {
	if len(contexts) > 0 && contexts[0] != nil {
		return contexts[0]
	}
	return context.Background()
}
func (a *Auth) Account(contexts ...context.Context) GitHubAccount {
	ctx, cancel := context.WithTimeout(optionalContext(contexts), 15*time.Second)
	defer cancel()
	c := newCommands(a.opts.StateDir, a.opts.GetToken, a.opts.HTTPClient, a.opts.GraphQLURL)
	reply, e := c.graphql(ctx, "query NootifyViewer { viewer { login } }", nil, false)
	if e != nil {
		account := GitHubAccount{}
		if !errors.Is(e, ErrSignedOut) {
			account.Error = safeError(e)
		}
		return account
	}
	var v struct {
		Login string `json:"login"`
	}
	if json.Unmarshal(reply.Data["viewer"], &v) != nil || v.Login == "" {
		return GitHubAccount{Error: "GitHub did not return the authenticated viewer."}
	}
	return GitHubAccount{SignedIn: true, Login: v.Login}
}
func (a *Auth) Settings(contexts ...context.Context) GitHubSettings {
	return GitHubSettings{Account: a.Account(contexts...), Login: a.Login()}
}
func (a *Auth) Start(contexts ...context.Context) GitHubLogin {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return GitHubLogin{Status: "failed", Error: "GitHub authentication is stopped"}
	}
	if a.flow.Status == "starting" || a.flow.Status == "waiting" {
		return a.flow
	}
	a.generation++
	generation := a.generation
	ctx, cancel := context.WithCancel(optionalContext(contexts))
	a.cancel = cancel
	a.flow = GitHubLogin{Status: "starting"}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		defer cancel()
		if e := a.run(ctx, generation); e != nil && ctx.Err() == nil {
			a.mu.Lock()
			if a.generation == generation {
				a.flow = GitHubLogin{Status: "failed", Error: safeError(e)}
			}
			a.mu.Unlock()
		}
	}()
	return a.flow
}
func (a *Auth) post(ctx context.Context, path string, fields url.Values, target any) error {
	call, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(call, "POST", strings.TrimRight(a.opts.GitHubURL, "/")+"/"+path, strings.NewReader(fields.Encode()))
	if e != nil {
		return e
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", UserAgent)
	res, e := a.opts.HTTPClient.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	return json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(target)
}
func (a *Auth) setFlow(generation uint64, flow GitHubLogin) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.generation != generation || a.closed {
		return false
	}
	a.flow = flow
	return true
}
func (a *Auth) run(ctx context.Context, generation uint64) error {
	var device struct {
		DeviceCode      string   `json:"device_code"`
		UserCode        string   `json:"user_code"`
		VerificationURI string   `json:"verification_uri"`
		ExpiresIn       *float64 `json:"expires_in"`
		Interval        *float64 `json:"interval"`
		Error           string   `json:"error"`
	}
	if e := a.post(ctx, "login/device/code", url.Values{"client_id": {a.opts.ClientID}, "scope": {"repo read:org"}}, &device); e != nil {
		return e
	}
	if device.DeviceCode == "" || device.UserCode == "" {
		if device.Error == "" {
			device.Error = "unexpected_reply"
		}
		return errors.New(device.Error)
	}
	lifetime := 900.0
	if device.ExpiresIn != nil {
		lifetime = *device.ExpiresIn
	}
	expires := time.Now().Add(time.Duration(lifetime * float64(time.Second)))
	page := device.VerificationURI
	if page == "" {
		page = "https://github.com/login/device"
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if !a.setFlow(generation, GitHubLogin{Status: "waiting", Code: device.UserCode, URL: page, ExpiresAt: dateISO(expires)}) {
		return context.Canceled
	}
	interval := 5.0
	if device.Interval != nil {
		interval = *device.Interval
	}
	if interval < 0 {
		interval = 0
	}
	for {
		timer := time.NewTimer(time.Duration(interval * float64(time.Second)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if time.Now().After(expires) {
			return errors.New("expired_token")
		}
		var reply struct {
			AccessToken string   `json:"access_token"`
			Interval    *float64 `json:"interval"`
			Error       string   `json:"error"`
		}
		if e := a.post(ctx, "login/oauth/access_token", url.Values{"client_id": {a.opts.ClientID}, "device_code": {device.DeviceCode}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}}, &reply); e != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue
		}
		if reply.AccessToken != "" {
			a.tokenWrites.Lock()
			a.mu.Lock()
			valid := a.generation == generation && !a.closed && ctx.Err() == nil
			a.mu.Unlock()
			if !valid {
				a.tokenWrites.Unlock()
				return context.Canceled
			}
			if a.opts.SetToken == nil {
				a.tokenWrites.Unlock()
				return errors.New("GitHub token persistence is not configured")
			}
			e := a.opts.SetToken(reply.AccessToken)
			a.tokenWrites.Unlock()
			if e != nil {
				return e
			}
			if !a.setFlow(generation, GitHubLogin{Status: "idle"}) {
				return context.Canceled
			}
			a.emit(map[string]any{"source": "pulls", "status": "github_login"})
			a.changed()
			return nil
		}
		switch reply.Error {
		case "slow_down":
			if reply.Interval != nil {
				interval = *reply.Interval
			} else {
				interval += 5
			}
		case "authorization_pending":
		default:
			if reply.Error == "" {
				reply.Error = "unexpected_reply"
			}
			return errors.New(reply.Error)
		}
	}
}
func (a *Auth) cancelLocked() {
	if a.cancel != nil {
		a.cancel()
	}
	a.generation++
	a.cancel = nil
	if a.flow.Status == "starting" || a.flow.Status == "waiting" {
		a.flow = GitHubLogin{Status: "idle"}
	}
}
func (a *Auth) Cancel() GitHubLogin {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancelLocked()
	return a.flow
}
func (a *Auth) SignOut() error {
	a.tokenWrites.Lock()
	defer a.tokenWrites.Unlock()
	a.Cancel()
	if a.opts.SetToken == nil {
		return fmt.Errorf("GitHub token persistence is not configured")
	}
	if e := a.opts.SetToken(""); e != nil {
		return e
	}
	a.emit(map[string]any{"source": "pulls", "status": "github_logout"})
	a.changed()
	return nil
}
func (a *Auth) Close() error {
	a.mu.Lock()
	a.closed = true
	a.cancelLocked()
	a.mu.Unlock()
	a.wg.Wait()
	return nil
}
func (a *Auth) emit(record map[string]any) {
	if a.opts.Report != nil {
		defer func() { _ = recover() }()
		a.opts.Report(record)
	}
}
func (a *Auth) changed() {
	if a.opts.Changed != nil {
		defer func() { _ = recover() }()
		a.opts.Changed()
	}
}
