package host

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLANListenerAcceptsAvailableFixedPort(t *testing.T) {
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	listener, err := listenLAN(port)
	if err != nil {
		t.Fatal("loopback reservation prevented the wildcard listener:", err)
	}
	defer listener.Close()
	connection, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err != nil {
		t.Fatal("fixed-port listener lost loopback access:", err)
	}
	connection.Close()
}

func TestLANServiceBoundary(t *testing.T) {
	s := newFixture(t)
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, peer string, token bool) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "http://"+net.JoinHostPort(hostname, strconv.Itoa(s.options.Port))+path, strings.NewReader("{}"))
		r.RemoteAddr = peer
		r.Header.Set("X-Nootify-UI", "1")
		r.Header.Set("X-Forwarded-For", "127.0.0.1")
		if token {
			r.Header.Set("Authorization", "Bearer "+s.store.Token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	for _, peer := range []string{"192.168.10.20:5000", "10.2.3.4:5000", "172.17.2.3:5000", "[fd12::5]:5000"} {
		for _, path := range []string{"/health", "/ui/api/providers", "/ui/api/settings", "/ui/api/settings/remote"} {
			w := request("GET", path, peer, false)
			if w.Code != 200 {
				t.Fatalf("LAN %s %s: %d %s", peer, path, w.Code, w.Body.String())
			}
			if path != "/health" {
				var page map[string]any
				if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
					t.Fatal(err)
				}
				if page["editable"] != false {
					t.Fatal("LAN inherited local editing", page)
				}
			}
		}
		for _, path := range []string{"/ui/api/providers", "/ui/api/settings/remote/secret", "/ui/api/settings/lark/secret", "/ui/api/agents", "/ui/api/auth/grant"} {
			if w := request("POST", path, peer, true); w.Code != 403 {
				t.Fatalf("LAN could mutate/read local secrets %s: %d", path, w.Code)
			}
		}
		if w := request("GET", "/v1/services", peer, false); w.Code != 401 {
			t.Fatal("LAN control did not require bearer", w.Code)
		}
		if w := request("GET", "/v1/services", peer, true); w.Code != 200 {
			t.Fatal("Authenticated LAN control failed", w.Code)
		}
		if w := request("GET", "/v1/remote/identity", peer, true); w.Code != 403 {
			t.Fatal("LAN identity management permitted", w.Code)
		}
	}
	for _, peer := range []string{"203.0.113.7:5000", "[2001:db8::1]:5000", "100.64.0.2:5000", "", "localhost:5000"} {
		if w := request("GET", "/health", peer, false); w.Code != 403 {
			t.Fatalf("non-LAN peer accepted %q: %d", peer, w.Code)
		}
	}
	for _, method := range []string{"GET", "POST"} {
		if w := request(method, "/ui/api/settings/tailscale", "127.0.0.1:5000", false); w.Code != 404 {
			t.Fatalf("removed settings endpoint: %d %s", w.Code, w.Body.String())
		}
	}
}
func TestListenerAcceptsActualLANAddress(t *testing.T) {
	s := newFixture(t)
	addresses := interfaceAddresses()
	ipv4 := addresses[:0]
	for _, address := range addresses {
		if address.Is4() {
			ipv4 = append(ipv4, address)
		}
	}
	addresses = ipv4
	if len(addresses) == 0 {
		t.Skip("No private LAN interface available")
	}
	address := net.JoinHostPort(addresses[0].String(), strconv.Itoa(s.options.Port))
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://" + address + "/health")
	if err != nil {
		t.Fatal("Listener is not available on own LAN address", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("LAN health", response.StatusCode)
	}
	var health map[string]any
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health["backend"] != "go" {
		t.Fatal("LAN did not reach Go service", health)
	}
}
