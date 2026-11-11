package network

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/idy/nootify/native/tailscale"
)

type tailnetKey struct{}
type peerKey struct{}

// IsTailnet reports that this request arrived through the private PROXY ingress
// and passed the embedded node's Host and device-owner authorization checks.
func IsTailnet(r *http.Request) bool {
	trusted, _ := r.Context().Value(tailnetKey{}).(bool)
	return trusted
}

type identity struct {
	login string
	until time.Time
}

type access struct {
	mu                        sync.Mutex
	names                     map[string]bool
	owner, address, listening string
	identities                map[string]identity
	users                     []string
}

func newAccess() *access {
	a := &access{identities: make(map[string]identity)}
	for _, user := range strings.Split(os.Getenv("NOOTIFY_TAILNET_USERS"), ",") {
		if user = strings.TrimSpace(user); user != "" {
			a.users = append(a.users, user)
		}
	}
	return a
}

func (a *access) publish(status tailscale.StatusResult) {
	names := map[string]bool{}
	var owner, address string
	if status.BackendState == "Running" && status.Self != nil {
		self := status.Self
		if name := strings.TrimSuffix(strings.ToLower(self.DNSName), "."); name != "" {
			names[name] = true
			names[strings.Split(name, ".")[0]] = true
		}
		for _, ip := range self.TailscaleIPs {
			ip = ip.Unmap()
			names[ip.String()] = true
			if address == "" && ip.Is4() {
				address = ip.String()
			}
		}
		owner = status.User[self.UserID].LoginName
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.owner != owner || a.address != address {
		a.identities = make(map[string]identity)
	}
	a.names, a.owner, a.address = names, owner, address
	a.listening = ""
	if status.NootifyListening {
		a.listening = address
	}
}

func (a *access) URL() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.listening == "" {
		return ""
	}
	return "http://" + a.listening + "/"
}

func (a *access) authorize(ctx context.Context, node embedded, host, peer string) string {
	u, err := url.Parse("http://" + host)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "Invalid Host header"
	}
	hostname := strings.ToLower(u.Hostname())
	ip, err := netip.ParseAddr(peer)
	if err != nil || ip.Zone() != "" {
		return "Unknown peer address"
	}
	ip = ip.Unmap()
	a.mu.Lock()
	if !a.names[hostname] {
		a.mu.Unlock()
		return "Use the Nootify device's Tailscale address"
	}
	owner, address := a.owner, a.address
	allowed := append([]string(nil), a.users...)
	if len(allowed) == 0 && owner != "" {
		allowed = []string{owner}
	}
	cached := a.identities[ip.String()]
	a.mu.Unlock()
	login := ""
	if time.Now().Before(cached.until) {
		login = cached.login
	}
	if login == "" && node != nil {
		who, err := node.WhoIs(ctx, ip.String())
		if err == nil && who != nil && who.Node != nil && !who.Node.IsTagged() && who.UserProfile != nil {
			login = who.UserProfile.LoginName
		}
		if login != "" {
			a.mu.Lock()
			if a.owner != owner || a.address != address {
				a.mu.Unlock()
				return "This Tailscale identity is not allowed"
			}
			if len(a.identities) >= 256 {
				for key := range a.identities {
					delete(a.identities, key)
					break
				}
			}
			a.identities[ip.String()] = identity{login, time.Now().Add(time.Minute)}
			a.mu.Unlock()
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.owner != owner || a.address != address || !a.names[hostname] {
		return "This Tailscale identity is not allowed"
	}
	for _, user := range allowed {
		if login != "" && login == user {
			return ""
		}
	}
	return "This Tailscale identity is not allowed"
}

func peerIP(remote string) string {
	if host, _, err := net.SplitHostPort(remote); err == nil {
		return host
	}
	return remote
}

func loginURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "login.tailscale.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
		return ""
	}
	code, ok := strings.CutPrefix(u.Path, "/a/")
	if !ok || code == "" {
		return ""
	}
	for _, ch := range code {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9') {
			return ""
		}
	}
	return u.String()
}
