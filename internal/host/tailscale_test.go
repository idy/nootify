package host

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTailscalePeerRequiresActualTailscaleDestination(t *testing.T) {
	for _, tc := range []struct {
		name, peer, local string
		allowed           bool
	}{
		{"tailnet", "100.101.102.103:5000", "100.90.80.70", true},
		{"range start", "100.64.0.1:5000", "100.64.0.2", true},
		{"range end", "100.127.255.254:5000", "100.127.255.253", true},
		{"mapped IPv4", "[::ffff:100.101.102.103]:5000", "::ffff:100.90.80.70", true},
		{"CGNAT to LAN", "100.101.102.103:5000", "192.168.1.20", false},
		{"CGNAT to loopback", "100.101.102.103:5000", "127.0.0.1", false},
		{"missing socket", "100.101.102.103:5000", "", false},
		{"wildcard is not destination", "100.101.102.103:5000", "0.0.0.0", false},
		{"before range", "100.63.255.255:5000", "100.90.80.70", false},
		{"after range", "100.128.0.1:5000", "100.90.80.70", false},
		{"public peer", "203.0.113.7:5000", "100.90.80.70", false},
		{"malformed peer", "localhost:5000", "100.90.80.70", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://example.test/health", nil)
			r.RemoteAddr = tc.peer
			// Neither forwarded peers nor forwarded destinations grant access.
			r.Header.Set("X-Forwarded-For", "100.101.102.103")
			r.Header.Set("X-Forwarded-Host", "100.90.80.70:9417")
			r.Header.Set("Forwarded", "for=100.101.102.103;host=100.90.80.70:9417")
			if tc.local != "" {
				r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.ParseIP(tc.local), Port: 9417}))
			}
			if got := lanPeer(r); got != tc.allowed {
				t.Fatalf("peer %q to %q: allowed=%v, want %v", tc.peer, tc.local, got, tc.allowed)
			}
		})
	}
}

func TestTailscaleServiceBoundary(t *testing.T) {
	s := newFixture(t)
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path string, token bool) *http.Request {
		r := httptest.NewRequest(method, "http://"+net.JoinHostPort(hostname, strconv.Itoa(s.options.Port))+path, strings.NewReader("{}"))
		r.RemoteAddr = "100.101.102.103:5000"
		r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.ParseIP("100.90.80.70"), Port: s.options.Port}))
		r.Header.Set("X-Nootify-UI", "1")
		r.Header.Set("X-Forwarded-For", "127.0.0.1")
		if token {
			r.Header.Set("Authorization", "Bearer "+s.store.Token)
		}
		return r
	}
	serve := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/health", "/", "/ui/api/snapshot", "/ui/api/providers", "/ui/api/agents", "/ui/api/settings", "/ui/api/settings/remote"} {
		w := serve(request("GET", path, false))
		if w.Code != http.StatusOK {
			t.Fatalf("Tailscale GET %s: %d %s", path, w.Code, w.Body.String())
		}
		if strings.HasPrefix(path, "/ui/api/") && path != "/ui/api/snapshot" {
			var page map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
				t.Fatal(err)
			}
			if page["editable"] != false {
				t.Fatal("Tailscale inherited local editing", page)
			}
		}
	}
	for _, path := range []string{"/ui/api/providers", "/ui/api/providers/registration", "/ui/api/providers/setup", "/ui/api/settings/remote/secret", "/ui/api/settings/lark/secret", "/ui/api/agents", "/ui/api/auth/grant", "/ui/api/secure", "/v1/remote/identity"} {
		if w := serve(request("POST", path, true)); w.Code != http.StatusForbidden {
			t.Fatalf("Tailscale local-only POST %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	if w := serve(request("GET", "/v1/services", false)); w.Code != http.StatusUnauthorized {
		t.Fatal("Tailscale control did not require bearer", w.Code)
	}
	if w := serve(request("GET", "/v1/services", true)); w.Code != http.StatusOK {
		t.Fatal("Authenticated Tailscale control failed", w.Code)
	}
	if w := serve(request("GET", "/v1/remote/identity", true)); w.Code != http.StatusForbidden {
		t.Fatal("Tailscale identity management permitted", w.Code)
	}
	for _, change := range []struct{ header, value string }{
		{"Host", "attacker.example:" + strconv.Itoa(s.options.Port)},
		{"Host", "127.0.0.1:" + strconv.Itoa(s.options.Port)},
		{"Host", net.JoinHostPort(hostname, strconv.Itoa(s.options.Port+1))},
		{"Origin", "http://attacker.example"},
		{"Sec-Fetch-Site", "cross-site"},
		{"Sec-Fetch-Site", "same-site"},
	} {
		r := request("GET", "/ui/api/snapshot", false)
		if change.header == "Host" {
			r.Host = change.value
		} else {
			r.Header.Set(change.header, change.value)
		}
		if w := serve(r); w.Code != http.StatusForbidden {
			t.Fatalf("Tailscale bypassed %s: %d", change.header, w.Code)
		}
	}
	foreign := netip.MustParseAddr("100.64.0.1")
	own := interfaceAddresses()
	for {
		found := false
		for _, address := range own {
			found = found || address == foreign
		}
		if !found {
			break
		}
		foreign = foreign.Next()
	}
	r := request("GET", "/health", false)
	r.Host = net.JoinHostPort(foreign.String(), strconv.Itoa(s.options.Port))
	if w := serve(r); w.Code != http.StatusForbidden {
		t.Fatal("Unassigned Tailscale Host accepted", w.Code)
	}
}

func TestNetworkURLsSeparateLANAndTailscale(t *testing.T) {
	for _, tc := range []struct {
		name      string
		addresses []string
		lan, tail string
	}{
		{"both", []string{"100.101.102.103", "192.168.1.20"}, "http://192.168.1.20:12345/", "http://100.101.102.103:12345/"},
		{"Tailscale only", []string{"100.101.102.103"}, "", "http://100.101.102.103:12345/"},
		{"LAN only", []string{"192.168.1.20"}, "http://192.168.1.20:12345/", ""},
		{"LAN prefers IPv4", []string{"fd12::5", "10.2.3.4", "100.101.102.103"}, "http://10.2.3.4:12345/", "http://100.101.102.103:12345/"},
		{"LAN IPv6 fallback", []string{"fd12::5"}, "http://[fd12::5]:12345/", ""},
		{"mapped IPv4", []string{"::ffff:100.101.102.103", "::ffff:192.168.1.20"}, "http://192.168.1.20:12345/", "http://100.101.102.103:12345/"},
		{"unavailable", nil, "", ""},
		{"ignore other addresses", []string{"127.0.0.1", "203.0.113.7", "169.254.1.2", "100.63.255.255", "100.128.0.1"}, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var addresses []netip.Addr
			for _, address := range tc.addresses {
				addresses = append(addresses, netip.MustParseAddr(address))
			}
			lan, tail := networkURLs(addresses, 12345)
			if lan != tc.lan || tail != tc.tail {
				t.Fatalf("URLs=(%q, %q), want (%q, %q)", lan, tail, tc.lan, tc.tail)
			}
		})
	}
}

func TestListenerAcceptsActualTailscaleAddress(t *testing.T) {
	_, address := networkURLs(interfaceAddresses(), 0)
	if address == "" {
		t.Skip("No OS Tailscale IPv4 interface available")
	}
	s := newFixture(t)
	_, address = networkURLs(interfaceAddresses(), s.options.Port)
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Get(address + "health")
	if err != nil {
		t.Fatal("Listener is not available on own Tailscale address", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal("Tailscale health", response.StatusCode)
	}
	var health map[string]any
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health["backend"] != "go" {
		t.Fatal("Tailscale did not reach Go service", health)
	}
}
