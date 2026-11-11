package host

import (
	"net"
	"net/http"
	"net/netip"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// macOS and Windows permit a wildcard socket to coexist with an already bound
// loopback socket. Reserve the exact CLI/desktop endpoint before binding the
// wildcard so an old loopback-only service is rejected before any state opens.
func listenLAN(port int) (net.Listener, error) {
	if (runtime.GOOS == "darwin" || runtime.GOOS == "windows") && port != 0 {
		guard, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return nil, err
		}
		defer guard.Close()
	}
	return net.Listen("tcp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
}

// LAN authority is derived from the accepted socket and this computer's own
// interfaces, never forwarding headers, DNS answers, or an embedded VPN device.
func peerAddress(r *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, false
	}
	ip, err := netip.ParseAddr(host)
	return ip.Unmap(), err == nil
}
func localPeer(r *http.Request) bool { ip, ok := peerAddress(r); return ok && ip.IsLoopback() }
func lanPeer(r *http.Request) bool {
	ip, ok := peerAddress(r)
	return ok && (ip.IsLoopback() || ip.IsPrivate())
}
func (s *Server) allowedHost(r *http.Request) bool {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		return false
	}
	if port != strconv.Itoa(s.options.Port) {
		return false
	}
	host = strings.ToLower(host)
	if host == "localhost" {
		return localPeer(r)
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		if ip.IsLoopback() {
			return localPeer(r)
		}
		if !ip.IsPrivate() {
			return false
		}
		for _, own := range interfaceAddresses() {
			if ip == own {
				return true
			}
		}
		return false
	}
	name, err := os.Hostname()
	return err == nil && strings.EqualFold(host, name) && !strings.ContainsAny(host, "/?#@")
}
func interfaceAddresses() []netip.Addr {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	result := []netip.Addr{}
	for _, address := range addresses {
		prefix, err := netip.ParsePrefix(address.String())
		if err == nil {
			ip := prefix.Addr().Unmap()
			if ip.IsPrivate() {
				result = append(result, ip)
			}
		}
	}
	return result
}
func (s *Server) lanURL() string {
	addresses := interfaceAddresses()
	for _, ip := range addresses {
		if ip.Is4() {
			return "http://" + net.JoinHostPort(ip.String(), strconv.Itoa(s.options.Port)) + "/"
		}
	}
	for _, ip := range addresses {
		return "http://" + net.JoinHostPort(ip.String(), strconv.Itoa(s.options.Port)) + "/"
	}
	return ""
}
