package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/idy/nootify/internal/webui"
	"github.com/idy/nootify/public"
)

// OwnedUI's trusted gateway lives in the desktop process. Its lifetime is exactly
// the context or explicit Close; service restarts do not replace its asset origin.
type OwnedUI struct {
	URL     string
	gateway *webui.Gateway
}

func (u *OwnedUI) Alive() bool { return u != nil && u.gateway != nil && u.gateway.Alive() }
func (u *OwnedUI) Close() {
	if u != nil && u.gateway != nil {
		_ = u.gateway.Close()
	}
}
func (u *OwnedUI) Origin() string {
	if u == nil || u.gateway == nil {
		return ""
	}
	return u.gateway.Origin()
}
func (u *OwnedUI) Done() <-chan struct{} { return u.gateway.Done() }

var ownerRoutePattern = regexp.MustCompile(`^#/[a-z-]+(?:/[a-z-]+)?$`)
var tokenPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (m *Manager) OpenUI(ctx context.Context, currentRoute string) (*OwnedUI, error) {
	route := "#/logs"
	if ownerRoutePattern.MatchString(currentRoute) {
		route = currentRoute
	}
	tokenPath := filepath.Join(m.StateDir, "auth-token")
	info, err := os.Lstat(tokenPath)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("private service authorization is unavailable")
	}
	if m.platform != "windows" && info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("service authorization file is not private")
	}
	data, err := os.ReadFile(tokenPath)
	if err != nil {
		return nil, errors.New("private service authorization is unavailable")
	}
	token := strings.TrimSpace(string(data))
	if !tokenPattern.MatchString(token) {
		return nil, errors.New("invalid private service authorization")
	}
	gateway, err := webui.NewGateway(ctx, webui.Options{BaseURL: "http://" + m.address + "/", Token: token, Route: route, Assets: public.FS, StateDir: m.StateDir})
	if err != nil {
		return nil, err
	}
	return &OwnedUI{URL: gateway.URL, gateway: gateway}, nil
}
