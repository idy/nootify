package tailscale

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"testing"
	"time"
	"unsafe"

	winio "github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
)

func dialLocalTunnelFixture(ctx context.Context, address string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, address)
}

func TestWindowsTunnelPipeHasProtectedOwnerOnlyDACL(t *testing.T) {
	listener, err := listenLocalTunnel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	config, err := localTunnelPipeConfig()
	if err != nil {
		t.Fatal(err)
	}
	if duplicate, err := winio.ListenPipe(listener.Addr().String(), config); err == nil {
		duplicate.Close()
		t.Fatal("a second listener replaced the private pipe")
	}
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		accepted <- conn
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := dialLocalTunnelFixture(ctx, listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var server net.Conn
	select {
	case server = <-accepted:
		if server == nil {
			t.Fatal("private pipe accept failed")
		}
	case <-ctx.Done():
		t.Fatal("private pipe accept timed out")
	}
	defer server.Close()
	if _, ok := client.(interface{ CloseWrite() error }); !ok {
		t.Fatal("private pipe client lost half-close support")
	}
	if _, ok := server.(interface{ CloseWrite() error }); !ok {
		t.Fatal("private pipe server lost half-close support")
	}
	file := server.(interface{ Fd() uintptr })
	sd, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !owner.Equals(user.User.Sid) {
		t.Fatal("private pipe owner differs from the helper owner")
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("private pipe inherits access from another DACL")
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		t.Fatal("private pipe grants access beyond its owner")
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil {
		t.Fatal(err)
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || !sid.Equals(user.User.Sid) || ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
		t.Fatal("another local identity can reach the pipe admission queue")
	}
	// Exercise actual message-pipe EOF semantics on Windows, including a
	// response after the requester half-closes. This is not just a type check.
	client.SetDeadline(time.Now().Add(3 * time.Second))
	server.SetDeadline(time.Now().Add(3 * time.Second))
	request, response := []byte("\x00request\xff"), []byte("\x00response\xff")
	done := make(chan error, 1)
	go func() {
		_, err := client.Write(request)
		if err == nil {
			err = client.(interface{ CloseWrite() error }).CloseWrite()
		}
		if err == nil {
			var got []byte
			got, err = io.ReadAll(client)
			if err == nil && !bytes.Equal(got, response) {
				err = fmt.Errorf("pipe response bytes changed")
			}
		}
		done <- err
	}()
	got, err := io.ReadAll(server)
	if err != nil || !bytes.Equal(got, request) {
		t.Fatalf("pipe request/half-close failed: %v", err)
	}
	if _, err := server.Write(response); err != nil {
		t.Fatal(err)
	}
	if err := server.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("pipe response after half-close did not complete")
	}
}
