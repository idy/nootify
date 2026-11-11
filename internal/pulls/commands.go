package pulls

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var ErrSignedOut = errors.New("Not signed in to GitHub")

const UserAgent = "Nootify"
const defaultGraphQLURL = "https://api.github.com/graphql"

type graphError struct {
	Message string `json:"message"`
	Path    []any  `json:"path"`
}
type graphReply struct {
	Data    map[string]json.RawMessage `json:"data"`
	Errors  []graphError               `json:"errors"`
	Message string                     `json:"message"`
}
type Remote struct {
	Name       string
	Repository string
}
type remoteResult struct {
	done    chan struct{}
	remotes []Remote
	err     error
}
type commands struct {
	dir      string
	token    func() string
	client   *http.Client
	endpoint string
	mu       sync.Mutex
	remotes  map[string]*remoteResult
}

func newCommands(dir string, token func() string, client *http.Client, endpoint string) *commands {
	return &commands{dir: dir, token: token, client: client, endpoint: endpoint, remotes: map[string]*remoteResult{}}
}
func (c *commands) graphql(ctx context.Context, query string, variables map[string]any, partial bool) (graphReply, error) {
	if !regexp.MustCompile(`^\s*query\s`).MatchString(query) {
		return graphReply{}, errors.New("Only read-only GitHub queries are allowed.")
	}
	if err := ctx.Err(); err != nil {
		return graphReply{}, err
	}
	token := ""
	if c.token != nil {
		token = c.token()
	}
	if token == "" {
		return graphReply{}, ErrSignedOut
	}
	call, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if variables == nil {
		variables = map[string]any{}
	}
	body, _ := json.Marshal(map[string]any{"query": query, "variables": variables})
	req, e := http.NewRequestWithContext(call, "POST", c.endpoint, bytes.NewReader(body))
	if e != nil {
		return graphReply{}, e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	res, e := c.client.Do(req)
	if e != nil {
		if ctx.Err() != nil {
			return graphReply{}, ctx.Err()
		}
		return graphReply{}, fmt.Errorf("Cannot reach GitHub: %s", safeError(e))
	}
	defer res.Body.Close()
	if res.StatusCode == 401 {
		return graphReply{}, ErrSignedOut
	}
	var reply graphReply
	e = json.NewDecoder(io.LimitReader(res.Body, 32*1024*1024)).Decode(&reply)
	if e != nil {
		return graphReply{}, fmt.Errorf("GitHub returned HTTP %d without JSON.", res.StatusCode)
	}
	if reply.Data == nil || (len(reply.Errors) > 0 && !partial) {
		msgs := []string{}
		for _, e := range reply.Errors {
			msgs = append(msgs, e.Message)
		}
		message := strings.Join(msgs, "; ")
		if message == "" {
			message = reply.Message
		}
		if message == "" {
			message = fmt.Sprintf("GitHub returned HTTP %d with no query data.", res.StatusCode)
		}
		return graphReply{}, errors.New(message)
	}
	return reply, nil
}
func (c *commands) readRemotes(ctx context.Context, directory string) ([]Remote, error) {
	c.mu.Lock()
	cached := c.remotes[directory]
	if cached != nil {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-cached.done:
			return cached.remotes, cached.err
		}
	}
	cached = &remoteResult{done: make(chan struct{})}
	c.remotes[directory] = cached
	c.mu.Unlock()
	defer close(cached.done)
	git := "git"
	if runtime.GOOS == "darwin" {
		git = "/usr/bin/git"
	}
	stdout, err := runCommand(ctx, c.dir, 10*time.Second, git, "-C", directory, "config", "--local", "--get-regexp", `^remote\..*\.url$`)
	if err != nil {
		var exit *commandError
		if errors.As(err, &exit) && exit.code == 1 && strings.TrimSpace(exit.stderr) == "" {
			cached.remotes = []Remote{}
			return cached.remotes, nil
		}
		cached.err = err
		return nil, err
	}
	re := regexp.MustCompile(`(?i)^remote\.(.+)\.url\s+(.+)$`)
	cached.remotes = []Remote{}
	for _, line := range strings.Split(stdout, "\n") {
		if m := re.FindStringSubmatch(strings.TrimSuffix(line, "\r")); m != nil {
			repo := ParseGitHubRemote(m[2])
			if repo != "" {
				cached.remotes = append(cached.remotes, Remote{m[1], repo})
			}
		}
	}
	return cached.remotes, nil
}

type commandError struct {
	code            int
	stderr, message string
}

func (e *commandError) Error() string {
	if strings.TrimSpace(e.stderr) != "" {
		return e.stderr
	}
	return e.message
}

type boundedBuffer struct {
	bytes.Buffer
	maximum int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len()+n > b.maximum {
		left := b.maximum - b.Len()
		if left > 0 {
			b.Buffer.Write(p[:left])
		}
		return n, errors.New("Read-only command output exceeds 16 MiB.")
	}
	return b.Buffer.Write(p)
}

// CommandContext kills canceled commands; WaitDelay bounds pipe cleanup if descendants keep descriptors open.
func runCommand(ctx context.Context, dir string, timeout time.Duration, file string, args ...string) (string, error) {
	call, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(call, file, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	cmd.WaitDelay = time.Second
	stdout := &boundedBuffer{maximum: 16 * 1024 * 1024}
	stderr := &boundedBuffer{maximum: 16 * 1024 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	e := cmd.Run()
	if e != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if call.Err() != nil {
			return "", errors.New("Read-only command exceeded its timeout.")
		}
		code := -1
		var exit *exec.ExitError
		if errors.As(e, &exit) {
			code = exit.ExitCode()
		}
		return "", &commandError{code: code, stderr: stderr.String(), message: e.Error()}
	}
	return stdout.String(), nil
}
func defaultHTTPClient(input *http.Client) *http.Client {
	var out http.Client
	if input != nil {
		out = *input
	}
	out.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return errors.New("HTTP redirects are not allowed") }
	return &out
}
