package webui

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/idy/nootify/internal/httpx"
)

type Options struct {
	BaseURL, Token, Route string
	Assets                fs.FS
}
type Gateway struct {
	URL        string
	origin     string
	options    Options
	server     *http.Server
	listener   net.Listener
	front      *Sessions
	capability Capability
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	once       sync.Once
	connMu     sync.Mutex
	upstream   *Client
}

func NewGateway(parent context.Context, options Options) (*Gateway, error) {
	route, err := Route(options.Route)
	if err != nil {
		return nil, err
	}
	if options.Assets == nil {
		return nil, errors.New("trusted UI assets are required")
	}
	ctx, cancel := context.WithCancel(parent)
	g := &Gateway{options: options, ctx: ctx, cancel: cancel, done: make(chan struct{}), front: NewSessions(false)}
	if _, err = g.connection(ctx); err != nil {
		cancel()
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		cancel()
		_ = g.upstream.Close()
		return nil, err
	}
	g.listener = listener
	g.origin = "http://" + listener.Addr().String()
	capability, err := g.front.Create(nil)
	if err != nil {
		listener.Close()
		cancel()
		_ = g.upstream.Close()
		return nil, err
	}
	g.capability = capability
	fragment := url.Values{"nootify-ui": {capability.ID + "." + capability.Key}, "route": {route}}
	g.URL = g.origin + "/#" + fragment.Encode()
	assets := Assets(options.Assets)
	proxy := http.HandlerFunc(g.proxy)
	g.server = &http.Server{ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 32 * 1024, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != listener.Addr().String() {
			httpx.WriteError(w, httpx.Fail(403, "Unexpected UI gateway host"))
			return
		}
		if origin := r.Header.Get("origin"); origin != "" && origin != g.origin {
			httpx.WriteError(w, httpx.Fail(403, "Cross-origin UI requests are not accepted"))
			return
		}
		if site := r.Header.Get("sec-fetch-site"); site != "" && site != "same-origin" && site != "none" {
			httpx.WriteError(w, httpx.Fail(403, "Cross-site UI requests are not accepted"))
			return
		}
		if r.URL.Path == "/ui/api/secure" {
			serveSecure(g.front, w, r, proxy)
			return
		}
		assets.ServeHTTP(w, r)
	})}
	go func() { _ = g.server.Serve(listener); _ = g.Close() }()
	go func() {
		select {
		case <-ctx.Done():
			_ = g.Close()
		case <-g.done:
		}
	}()
	return g, nil
}
func (g *Gateway) Origin() string        { return g.origin + "/" }
func (g *Gateway) Done() <-chan struct{} { return g.done }
func (g *Gateway) Alive() bool {
	select {
	case <-g.done:
		return false
	default:
		return g.capability.Expires > time.Now().UnixMilli()
	}
}
func (g *Gateway) connection(ctx context.Context) (*Client, error) {
	g.connMu.Lock()
	defer g.connMu.Unlock()
	if g.ctx.Err() != nil {
		return nil, errors.New("owner UI gateway is closing")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if g.upstream != nil && g.upstream.Healthy() {
		return g.upstream, nil
	}
	if g.upstream != nil {
		_ = g.upstream.Close()
		g.upstream = nil
	}
	capability, err := RequestSession(ctx, g.options.BaseURL, g.options.Token)
	if err != nil {
		return nil, err
	}
	client, err := NewClient(g.options.BaseURL, capability)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil || g.ctx.Err() != nil {
		_ = client.Close()
		return nil, errors.New("owner UI authorization was cancelled")
	}
	g.upstream = client
	return client, nil
}

// A late failure from an old request must not retire the replacement session.
func (g *Gateway) retire(active *Client) {
	g.connMu.Lock()
	if g.upstream != active {
		g.connMu.Unlock()
		return
	}
	g.upstream = nil
	g.connMu.Unlock()
	_ = active.Close()
}

func (g *Gateway) proxy(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 185*time.Second)
	stop := context.AfterFunc(g.ctx, cancel)
	defer stop()
	defer cancel()
	g.proxyRequest(ctx, w, r)
}

func (g *Gateway) proxyRequest(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	// A gateway deadline indicates a stalled upstream. Only a caller disconnect
	// or gateway shutdown should preserve the session without reporting failure.
	cancelled := func() bool { return r.Context().Err() != nil || g.ctx.Err() != nil }
	active, err := g.connection(ctx)
	if err != nil {
		httpx.WriteError(w, httpx.Fail(502, "The authenticated background service connection is unavailable"))
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if err != nil || len(body) > 1024*1024 {
		httpx.WriteError(w, httpx.Fail(413, "UI request body is too large"))
		return
	}
	op := Operation{Method: r.Method, Path: r.URL.Path, Body: string(body)}
	var result *http.Response
	for attempt := 0; attempt < 2; attempt++ {
		result, err = active.Fetch(ctx, op)
		if err == nil {
			break
		}
		if cancelled() {
			return
		}
		g.retire(active)
		// Only GET may be replayed, and only before authenticated headers arrive.
		// POST may have committed even when its response was lost. A successful
		// Fetch (including a business error status) or a broken stream is final.
		if attempt != 0 || r.Method != http.MethodGet || ctx.Err() != nil {
			break
		}
		active, err = g.connection(ctx)
		if err != nil {
			break
		}
	}
	if err != nil {
		if !cancelled() {
			httpx.WriteError(w, httpx.Fail(502, "The authenticated background service connection was interrupted"))
		}
		return
	}
	defer result.Body.Close()
	for key, values := range result.Header {
		if strings.EqualFold(key, "content-type") || strings.EqualFold(key, "content-disposition") {
			w.Header()[key] = values
		}
	}
	w.WriteHeader(result.StatusCode)
	buffer := make([]byte, 64*1024)
	for {
		n, readErr := result.Body.Read(buffer)
		if n > 0 {
			if _, err = w.Write(buffer[:n]); err != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF && !cancelled() {
				g.retire(active)
			}
			return
		}
	}
}
func (g *Gateway) Close() error {
	var result error
	g.once.Do(func() {
		g.cancel()
		g.front.Clear()
		if g.server != nil {
			result = g.server.Close()
		} else if g.listener != nil {
			result = g.listener.Close()
		}
		g.connMu.Lock()
		upstream := g.upstream
		g.upstream = nil
		g.connMu.Unlock()
		if upstream != nil {
			_ = upstream.Close()
		}
		close(g.done)
	})
	return result
}
