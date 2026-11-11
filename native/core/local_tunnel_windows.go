package core

import (
	"context"
	"encoding/hex"
	"net"
	"strings"
	"unsafe"

	winio "github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
)

const localTunnelNetwork = "npipe"
const localTunnelPipePrefix = `\\.\pipe\nootify-tunnel-`

func validEmbeddedEndpoint(network, address string) bool {
	if network != localTunnelNetwork || !strings.HasPrefix(address, localTunnelPipePrefix) {
		return false
	}
	id := strings.TrimPrefix(address, localTunnelPipePrefix)
	if len(id) != 32 || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func privateTunnelPipe(conn net.Conn) bool {
	file, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return false
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !owner.Equals(user.User.Sid) {
		return false
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return false
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		return false
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
		return false
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	return sid.Equals(user.User.Sid) && ace.Header.AceFlags&windows.INHERIT_ONLY_ACE == 0
}

func dialEmbeddedEndpoint(ctx context.Context, network, address string) (net.Conn, error) {
	if !validEmbeddedEndpoint(network, address) {
		return nil, fault("unavailable", "private tunnel endpoint is unavailable")
	}
	conn, err := winio.DialPipeAccess(ctx, address, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL)
	if err != nil {
		return nil, fault("unavailable", "private tunnel endpoint is unavailable")
	}
	// Inspect the connected object before sending the capability, so a name
	// reused after helper shutdown cannot disclose it to another local owner.
	if !privateTunnelPipe(conn) {
		conn.Close()
		return nil, fault("unavailable", "private tunnel endpoint is unavailable")
	}
	return conn, nil
}
