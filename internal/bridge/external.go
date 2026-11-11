package bridge

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	_ "modernc.org/sqlite"
)

func localEndpoint(c BackendConnection, adapter string) (*url.URL, error) {
	u, err := url.Parse(c.URL)
	if err != nil {
		return nil, httpError(400, "Invalid backend URL")
	}
	protocol := u.Scheme == "http" || u.Scheme == "https"
	if adapter == "codex" {
		protocol = u.Scheme == "ws" || u.Scheme == "wss"
	}
	host := u.Hostname()
	if !protocol || (host != "localhost" && host != "127.0.0.1" && host != "::1") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(c.URL, "#") {
		return nil, httpError(400, "Backend endpoint must be a local URL without embedded credentials")
	}
	return u, nil
}
func (s *Service) connection(adapter string) (BackendConnection, error) {
	var c BackendConnection
	ok, err := s.options.Store.Get("backends", adapter, &c)
	if err != nil {
		return c, err
	}
	if ok {
		return c, nil
	}
	if adapter == "codex" {
		return BackendConnection{URL: os.Getenv("CODEX_APP_SERVER_URL"), Token: os.Getenv("CODEX_APP_SERVER_TOKEN")}, nil
	}
	return BackendConnection{URL: envPath("OPENCODE_SERVER_URL", "http://127.0.0.1:4096"), Username: envPath("OPENCODE_SERVER_USERNAME", "opencode"), Password: os.Getenv("OPENCODE_SERVER_PASSWORD")}, nil
}

type codexThread struct {
	ID       string
	Title    string
	Archived bool
}

var stateSQLiteRE = regexp.MustCompile(`^state_(\d+)\.sqlite$`)

func (s *Service) codexHome() string {
	return envPath("CODEX_HOME", filepath.Join(s.options.Home, ".codex"))
}
func (s *Service) findCodexThread(ctx context.Context, id string) (*codexThread, error) {
	files, err := entries(s.codexHome())
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, f := range files {
		if stateSQLiteRE.MatchString(f.Name()) {
			names = append(names, f.Name())
		}
	}
	sort.Slice(names, func(i, j int) bool {
		a, _ := strconv.Atoi(stateSQLiteRE.FindStringSubmatch(names[i])[1])
		b, _ := strconv.Atoi(stateSQLiteRE.FindStringSubmatch(names[j])[1])
		return a > b
	})
	if len(names) == 0 {
		return nil, nil
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(filepath.Join(s.codexHome(), names[0]))}
	db, err := sql.Open("sqlite", u.String()+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var tid, title any
	var archived any
	err = db.QueryRowContext(ctx, "SELECT id,title,archived FROM threads WHERE id = ?", id).Scan(&tid, &title, &archived)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	threadID, okID := tid.(string)
	threadTitle, okTitle := title.(string)
	flag, okFlag := archived.(int64)
	if !okID || !okTitle || !okFlag || (flag != 0 && flag != 1) || threadID != id {
		return nil, unavailable("archive_unknown")
	}
	return &codexThread{ID: threadID, Title: threadTitle, Archived: flag == 1}, nil
}
func (s *Service) checkCodexArchive(ctx context.Context, id string) error {
	thread, err := s.findCodexThread(ctx, id)
	if err != nil {
		return err
	}
	if thread == nil {
		return unavailable("session_not_local")
	}
	if thread.Archived {
		return unavailable("session_archived")
	}
	return nil
}
func (s *Service) sendExternal(ctx context.Context, id, text, adapter string, observed *PublicSession) (DeliveryResult, error) {
	if adapter == "opencode" {
		return s.sendOpenCode(ctx, id, text, observed)
	}
	thread, err := s.findCodexThread(ctx, id)
	if err != nil {
		return DeliveryResult{}, err
	}
	if thread == nil {
		return DeliveryResult{}, unavailable("session_not_local")
	}
	observed.SessionName = thread.Title
	if thread.Archived {
		return DeliveryResult{}, unavailable("session_archived")
	}
	c, err := s.connection("codex")
	if err != nil {
		return DeliveryResult{}, err
	}
	if c.URL == "" {
		if runtime.GOOS != "darwin" {
			return DeliveryResult{}, unavailable("backend_unavailable")
		}
		return s.sendCodexDesktop(ctx, id, text, observed)
	}
	return s.sendCodexRPC(ctx, id, text, c, observed)
}

type codexRPC struct {
	conn *websocket.Conn
	next int
}

func openCodexRPC(ctx context.Context, c BackendConnection) (*codexRPC, error) {
	u, err := localEndpoint(c, "codex")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	headers := http.Header{}
	if c.Token != "" {
		headers.Set("Authorization", "Bearer "+c.Token)
	}
	conn, _, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: headers, HTTPClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}})
	if err != nil {
		return nil, retry("Codex backend is unavailable")
	}
	conn.SetReadLimit(8 * 1024 * 1024)
	rpc := &codexRPC{conn: conn}
	if err := rpc.call(ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "nootify", "title": "Nootify", "version": "0.2.1"}}, nil); err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	raw, _ := json.Marshal(map[string]any{"method": "initialized", "params": map[string]any{}})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		_ = conn.CloseNow()
		return nil, retry("Codex initialization failed")
	}
	return rpc, nil
}
func (rpc *codexRPC) call(ctx context.Context, method string, params, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	rpc.next++
	id := rpc.next
	raw, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return httpError(400, "Codex request could not be serialized")
	}
	mutation := method == "turn/start" || method == "turn/steer"
	failed := func() error {
		if mutation {
			return uncertain("Codex input response was not received; delivery is unconfirmed")
		}
		return retry("Codex backend is unavailable")
	}
	if err = rpc.conn.Write(ctx, websocket.MessageText, raw); err != nil {
		return failed()
	}
	for {
		_, body, err := rpc.conn.Read(ctx)
		if err != nil {
			return failed()
		}
		var response struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &response) != nil {
			continue
		}
		if response.Method != "" {
			if response.ID != nil {
				rejection, _ := json.Marshal(map[string]any{"id": *response.ID, "error": map[string]any{"code": -32601, "message": "This bridge cannot answer interactive requests"}})
				if rpc.conn.Write(ctx, websocket.MessageText, rejection) != nil {
					return failed()
				}
			}
			continue
		}
		if response.ID == nil || *response.ID != id {
			continue
		}
		if response.Error != nil {
			detail := fmt.Sprintf("Codex RPC %d: %s", response.Error.Code, response.Error.Message)
			switch response.Error.Code {
			case -32600, -32601, -32602:
				return httpError(400, detail)
			}
			if mutation {
				return uncertain(detail)
			}
			return retry(detail)
		}
		if out != nil {
			if err := json.Unmarshal(response.Result, out); err != nil {
				if mutation {
					return uncertain("Invalid Codex input receipt")
				}
				return retry("Invalid Codex response")
			}
		}
		return nil
	}
}
func (s *Service) sendCodexRPC(ctx context.Context, id, text string, c BackendConnection, observed *PublicSession) (DeliveryResult, error) {
	rpc, err := openCodexRPC(ctx, c)
	if err != nil {
		return DeliveryResult{}, err
	}
	defer rpc.conn.CloseNow()
	var read struct {
		Thread struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Path   string `json:"path"`
			Status struct {
				Type string `json:"type"`
			} `json:"status"`
		} `json:"thread"`
	}
	if err := rpc.call(ctx, "thread/read", map[string]any{"threadId": id}, &read); err != nil {
		return DeliveryResult{}, err
	}
	t := read.Thread
	if t.ID != id {
		return DeliveryResult{}, retry("Codex returned a different thread")
	}
	for _, part := range strings.FieldsFunc(t.Path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == "archived_sessions" {
			return DeliveryResult{}, unavailable("session_archived")
		}
	}
	if t.Status.Type != "idle" && t.Status.Type != "active" {
		return DeliveryResult{}, unavailable("session_offline")
	}
	if t.Name != "" {
		observed.SessionName = t.Name
	}
	observed.Availability = "active"
	if err := s.checkCodexArchive(ctx, id); err != nil {
		return DeliveryResult{}, err
	}
	input := []any{map[string]any{"type": "text", "text": "[Nootify: " + observed.SessionName + "]\n" + text}}
	if t.Status.Type == "active" {
		var turns struct {
			Data []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"data"`
		}
		if err := rpc.call(ctx, "thread/turns/list", map[string]any{"threadId": id, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}, &turns); err != nil {
			return DeliveryResult{}, err
		}
		active := ""
		for _, turn := range turns.Data {
			if turn.Status == "inProgress" {
				active = turn.ID
				break
			}
		}
		if active == "" {
			return DeliveryResult{}, unavailable("session_busy")
		}
		if err := rpc.call(ctx, "turn/steer", map[string]any{"threadId": id, "expectedTurnId": active, "input": input}, nil); err != nil {
			return DeliveryResult{}, err
		}
	} else {
		if err := rpc.call(ctx, "turn/start", map[string]any{"threadId": id, "input": input}, nil); err != nil {
			return DeliveryResult{}, err
		}
	}
	return DeliveryResult{Status: "input_accepted"}, nil
}

type openCodeSession struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Directory string `json:"directory"`
	Time      *struct {
		Created  *float64        `json:"created"`
		Updated  *float64        `json:"updated"`
		Archived json.RawMessage `json:"archived"`
	} `json:"time"`
}

func openCodeRequest(ctx context.Context, c BackendConnection, method, id, directory string, body any) (int, []byte, error) {
	u, err := localEndpoint(c, "opencode")
	if err != nil {
		return 0, nil, err
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/session/" + url.PathEscape(id)
	if method == http.MethodPost {
		u.Path += "/prompt_async"
	}
	if directory != "" {
		q := u.Query()
		q.Set("directory", directory)
		u.RawQuery = q.Encode()
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	var data []byte
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return 0, nil, httpError(400, "Input could not be serialized")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(data))
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Password != "" {
		name := c.Username
		if name == "" {
			name = "opencode"
		}
		req.SetBasicAuth(name, c.Password)
	}
	client := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		if method == http.MethodPost {
			return 0, nil, uncertain("OpenCode input response was not received; delivery is unconfirmed")
		}
		return 0, nil, retry("OpenCode backend is unavailable")
	}
	defer response.Body.Close()
	data, err = io.ReadAll(io.LimitReader(response.Body, 8*1024*1024+1))
	if err != nil || len(data) > 8*1024*1024 {
		if method == http.MethodPost {
			return 0, nil, uncertain("Invalid OpenCode input response")
		}
		return 0, nil, retry("Invalid OpenCode lookup response")
	}
	return response.StatusCode, data, nil
}
func (s *Service) sendOpenCode(ctx context.Context, id, text string, observed *PublicSession) (DeliveryResult, error) {
	c, err := s.connection("opencode")
	if err != nil {
		return DeliveryResult{}, err
	}
	status, raw, err := openCodeRequest(ctx, c, http.MethodGet, id, c.Directory, nil)
	if err != nil {
		return DeliveryResult{}, err
	}
	if status == 404 {
		return DeliveryResult{}, unavailable("session_not_local")
	}
	if status != 200 {
		return DeliveryResult{}, retry(fmt.Sprintf("OpenCode lookup failed (HTTP %d)", status))
	}
	var session openCodeSession
	if json.Unmarshal(raw, &session) != nil || session.ID != id || session.Time == nil || session.Time.Created == nil || session.Time.Updated == nil {
		return DeliveryResult{}, unavailable("archive_unknown")
	}
	observed.SessionName = session.Title
	if len(session.Time.Archived) > 0 {
		return DeliveryResult{}, unavailable("session_archived")
	}
	observed.Availability = "active"
	directory := c.Directory
	if directory == "" {
		directory = session.Directory
	}
	status, _, err = openCodeRequest(ctx, c, http.MethodPost, id, directory, map[string]any{"parts": []any{map[string]any{"type": "text", "text": "[Nootify: " + observed.SessionName + "]\n" + text}}})
	if err != nil {
		return DeliveryResult{}, err
	}
	if status != 204 {
		message := fmt.Sprintf("OpenCode input failed (HTTP %d)", status)
		switch status {
		case 400, 404, 405, 413, 415, 422:
			return DeliveryResult{}, httpError(status, message)
		}
		if status >= 400 && status < 500 {
			return DeliveryResult{}, retry(message)
		}
		return DeliveryResult{}, uncertain(message + "; delivery is unconfirmed")
	}
	return DeliveryResult{Status: "input_accepted"}, nil
}
