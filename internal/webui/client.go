package webui

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// RequestSession proves ownership on one exact TCP connection. Neither the
// persistent token nor the derived traffic key is ever sent to the listener.
func RequestSession(ctx context.Context, baseURL, token string) (Capability, error) {
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme != "http" || base.User != nil || !isLoopback(base.Hostname()) || (base.Path != "" && base.Path != "/") || base.RawQuery != "" || base.Fragment != "" {
		return Capability{}, errors.New("owner authorization requires a local service origin")
	}
	address := base.Host
	if base.Port() == "" {
		address = net.JoinHostPort(base.Hostname(), "80")
	}
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return Capability{}, err
	}
	defer conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	reader := bufio.NewReader(conn)
	exchange := func(path string, body any, out any) error {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		method := "GET"
		if body != nil {
			method = "POST"
		}
		target := *base
		relative, _ := url.Parse(path)
		target.Path = relative.Path
		target.RawQuery = relative.RawQuery
		request, err := http.NewRequestWithContext(ctx, method, target.String(), bytes.NewReader(raw))
		if err != nil {
			return err
		}
		request.Header.Set("x-nootify-ui", "1")
		if body != nil {
			request.Header.Set("content-type", "application/json")
		}
		if err = request.Write(conn); err != nil {
			return err
		}
		response, err := http.ReadResponse(reader, request)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
		ce := response.Body.Close()
		if err == nil {
			err = ce
		}
		if err != nil {
			return err
		}
		if response.StatusCode != 200 || len(data) > 4096 {
			return errors.New("local service owner authorization is unavailable")
		}
		if err = json.Unmarshal(data, out); err != nil {
			return errors.New("invalid owner authorization response")
		}
		return nil
	}
	host := strings.ToLower(base.Host)
	client := nonce(24)
	var challenge struct {
		Nonce  string `json:"challenge"`
		Issued int64  `json:"issued_at"`
		Proof  string `json:"proof"`
	}
	if err = exchange("/ui/api/auth/challenge?nonce="+client, nil, &challenge); err != nil {
		return Capability{}, err
	}
	if !noncePattern.MatchString(challenge.Nonce) || challenge.Issued > time.Now().UnixMilli() || time.Now().UnixMilli()-challenge.Issued > 30000 || !equal(challenge.Proof, mac(token, "ui-server", host, client, challenge.Nonce, challenge.Issued)) {
		return Capability{}, errors.New("local service owner identity could not be verified")
	}
	var grant struct {
		Session Capability `json:"session"`
		Proof   string     `json:"proof"`
	}
	if err = exchange("/ui/api/auth/grant", map[string]any{"client_nonce": client, "challenge": challenge.Nonce, "issued_at": challenge.Issued, "server_proof": challenge.Proof, "proof": mac(token, "ui-client", host, client, challenge.Nonce, challenge.Issued, challenge.Proof)}, &grant); err != nil {
		return Capability{}, err
	}
	c := grant.Session
	if !noncePattern.MatchString(c.ID) || c.Expires <= time.Now().UnixMilli() || !equal(grant.Proof, mac(token, "ui-session", host, client, challenge.Nonce, challenge.Issued, c.ID, c.Expires)) {
		return Capability{}, errors.New("invalid owner authorization session")
	}
	c.Key = mac(token, "ui-session-key", host, client, challenge.Nonce, challenge.Issued, challenge.Proof, c.ID, c.Expires)
	return c, nil
}
func isLoopback(host string) bool { return host == "127.0.0.1" || host == "localhost" || host == "::1" }

type Client struct {
	origin string
	codec  *codec
	http   *http.Client
	broken atomic.Bool
}

func NewClient(origin string, capability Capability) (*Client, error) {
	cd, err := newCodec(capability)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}
	return &Client{origin: strings.TrimRight(origin, "/"), codec: cd, http: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) Healthy() bool {
	return !c.broken.Load() && c.codec.capability.Expires > time.Now().UnixMilli()
}
func (c *Client) Fetch(ctx context.Context, op Operation) (*http.Response, error) {
	revoking := op.Path == "/ui/api/auth/revoke" && op.Method == "POST"
	if !c.Healthy() && !revoking {
		return nil, errors.New("authorized UI connection was lost")
	}
	if !pathPattern.MatchString(op.Path) || op.Path == "/ui/api/secure" {
		return nil, errors.New("invalid UI request target")
	}
	requestID := nonce(24)
	envelope, err := c.codec.seal(op, requestID, "request")
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(envelope)
	request, err := http.NewRequestWithContext(ctx, "POST", c.origin+"/ui/api/secure", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-nootify-ui", "1")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*http.Response, error) {
		_ = response.Body.Close()
		if ctx.Err() == nil {
			c.broken.Store(true)
		}
		return nil, err
	}
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("content-type"), encryptedType) {
		return fail(errors.New("UI listener could not be authenticated"))
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	sequence := 0
	next := func() (Frame, error) {
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return Frame{}, err
			}
			return Frame{}, errors.New("authenticated UI response was interrupted")
		}
		var e Envelope
		if json.Unmarshal(scanner.Bytes(), &e) != nil {
			return Frame{}, errors.New("invalid UI envelope")
		}
		var frame Frame
		if err := c.codec.open(e, requestID, responseDirection(sequence), &frame); err != nil {
			return Frame{}, err
		}
		sequence++
		return frame, nil
	}
	first, err := next()
	if err != nil {
		return fail(err)
	}
	if first.Type != "headers" || first.Status < 200 || first.Status > 599 {
		return fail(errors.New("invalid authenticated UI response"))
	}
	pipe, writer := io.Pipe()
	body := &clientBody{PipeReader: pipe, network: response.Body}
	headers := make(http.Header)
	for key, v := range first.Headers {
		headers.Set(key, v)
	}
	go func() {
		defer response.Body.Close()
		var failure error
		defer func() {
			if failure != nil && ctx.Err() == nil && !body.closed.Load() {
				c.broken.Store(true)
			}
			_ = writer.CloseWithError(failure)
		}()
		for {
			frame, err := next()
			if err != nil {
				failure = err
				return
			}
			switch frame.Type {
			case "data":
				data, err := b64.DecodeString(frame.Data)
				if err != nil {
					failure = err
					return
				}
				if _, err = writer.Write(data); err != nil {
					failure = err
					return
				}
			case "end":
				if scanner.Scan() {
					failure = errors.New("unexpected bytes after authenticated UI completion")
					return
				}
				failure = scanner.Err()
				return
			default:
				failure = fmt.Errorf("invalid UI response frame %q", frame.Type)
				return
			}
		}
	}()
	return &http.Response{StatusCode: first.Status, Header: headers, Body: body}, nil
}

type clientBody struct {
	*io.PipeReader
	network io.Closer
	closed  atomic.Bool
}

func (b *clientBody) Close() error {
	b.closed.Store(true)
	_ = b.network.Close()
	return b.PipeReader.Close()
}
func (c *Client) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	response, err := c.Fetch(ctx, Operation{Method: "POST", Path: "/ui/api/auth/revoke"})
	if err == nil {
		_, err = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}
	c.broken.Store(true)
	c.http.CloseIdleConnections()
	return err
}
