package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"time"
)

//go:embed index.html offline.css offline.js titlebar.js fonts.css brand.svg fonts/* icons/*.png
var assets embed.FS

type offlineServer struct {
	URL      string
	server   *http.Server
	listener net.Listener
}

func startOffline() (*offlineServer, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &offlineServer{URL: "http://" + listener.Addr().String() + "/", listener: listener}
	s.server = &http.Server{ReadHeaderTimeout: 3 * time.Second, IdleTimeout: 15 * time.Second, Handler: offlineHandler(listener.Addr().String())}
	go func() { _ = s.server.Serve(listener) }()
	return s, nil
}
func offlineHandler(host string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		allowed := name == "index.html" || name == "offline.css" || name == "offline.js" || name == "fonts.css" || name == "brand.svg" || strings.HasPrefix(name, "fonts/")
		if !allowed || !fs.ValidPath(name) {
			http.NotFound(w, r)
			return
		}
		data, err := assets.ReadFile(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		switch {
		case strings.HasSuffix(name, ".html"):
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		case strings.HasSuffix(name, ".js"):
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		case strings.HasSuffix(name, ".css"):
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case strings.HasSuffix(name, ".svg"):
			w.Header().Set("Content-Type", "image/svg+xml")
		case strings.HasSuffix(name, ".woff2"):
			w.Header().Set("Content-Type", "font/woff2")
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		if r.Method == "GET" {
			_, _ = w.Write(data)
		}
	})
}
func (s *offlineServer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = s.server.Shutdown(ctx)
}
