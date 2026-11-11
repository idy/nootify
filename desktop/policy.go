package main

import (
	"net/url"
	"regexp"
	"strings"
)

type urlPolicy struct {
	offline, preview, gateway string
	isolated                  bool
}

func documentAt(raw, base string) bool {
	u, e := url.Parse(raw)
	b, be := url.Parse(base)
	return e == nil && be == nil && u.User == nil && u.Scheme == "http" && u.Host == b.Host && u.EscapedPath() == "/" && !strings.Contains(raw, "\\")
}
func (p urlPolicy) allowed(raw string) bool {
	return (!p.isolated && p.gateway != "" && documentAt(raw, p.gateway)) || documentAt(raw, p.offline) || (p.preview != "" && documentAt(raw, p.preview))
}
func previewURL(raw string) string {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "http" || u.User != nil || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Port() == "9417" || u.Port() == "0" || u.EscapedPath() != "/" || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") || u.Opaque != "" {
		return ""
	}
	return raw
}

var permissionPath = regexp.MustCompile(`^/app/cli_[a-fA-F0-9]{16}/auth$`)
var registrationQuery = regexp.MustCompile(`^user_code=[a-zA-Z0-9-]{4,64}$`)

func externalURL(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Opaque != "" || strings.ContainsAny(raw, "\\\r\n") {
		return false
	}
	switch u.Host {
	case "github.com":
		return true
	case "open.feishu.cn":
		if strings.Contains(raw, "#") {
			return false
		}
		if u.EscapedPath() == "/app" || u.EscapedPath() == "/app/" || permissionPath.MatchString(u.EscapedPath()) {
			return true
		}
		return u.EscapedPath() == "/page/cli" && registrationQuery.MatchString(u.RawQuery)
	}
	return false
}

// Exact strings reject aliases, ports, credentials, escaping, query and fragment.
func fixedAction(raw string) string {
	switch raw {
	case "nootify://window/drag":
		return "drag"
	case "nootify://window/zoom":
		return "zoom"
	case "nootify://update/check":
		return "check_update"
	case "nootify://update/install":
		return "install_update"
	case "nootify://update/details":
		return "about"
	case "nootify://language/system":
		return "language_system"
	case "nootify://language/zh-CN":
		return "language_zh-CN"
	case "nootify://language/en":
		return "language_en"
	case "nootify://service/start":
		return "start"
	case "nootify://service/restart":
		return "restart"
	case "nootify://service/install":
		return "install_service"
	case "nootify://service/refresh":
		return "refresh"
	case "nootify://settings/authorize":
		return "authorize_ui"
	}
	return ""
}
