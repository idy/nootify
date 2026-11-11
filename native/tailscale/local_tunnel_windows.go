package tailscale

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"

	winio "github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
)

const localTunnelNetwork = "npipe"
const localTunnelPipePrefix = `\\.\pipe\nootify-tunnel-`

func localTunnelPipeConfig() (*winio.PipeConfig, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return &winio.PipeConfig{
		// A protected, explicit owner-only DACL is in effect when the first
		// instance is created. Other local users cannot connect or create an
		// instance. go-winio also refuses existing names and remote clients.
		SecurityDescriptor: "O:" + user.User.Sid.String() + "D:P(A;;GA;;;" + user.User.Sid.String() + ")",
		// Reads remain a byte stream; message mode adds CloseWrite/EOF support.
		MessageMode: true,
	}, nil
}

func listenLocalTunnel(ctx context.Context) (net.Listener, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	config, err := localTunnelPipeConfig()
	if err != nil {
		return nil, err
	}
	var id [16]byte
	rand.Read(id[:])
	listener, err := winio.ListenPipe(localTunnelPipePrefix+hex.EncodeToString(id[:]), config)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}
