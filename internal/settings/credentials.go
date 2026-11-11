package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/idy/nootify/internal/storage"
)

// Credentials are private application credentials, never part of a settings page.
type Credentials struct {
	AppID     string `json:"app_id"`
	AppSecret string `json:"app_secret"`
}

// ResolveCredentials preserves the startup precedence: environment, saved settings, MCP file.
// An empty source means no application is configured. Partial environment credentials are an error.
func ResolveCredentials(store *storage.Store, mcpConfig string) (Credentials, string, error) {
	return resolveCredentials(envMap(), store.Setting("lark_app_id"), store.Setting("lark_app_secret"), mcpConfig)
}
func envMap() map[string]string {
	r := map[string]string{}
	for _, v := range os.Environ() {
		k, s, ok := strings.Cut(v, "=")
		if ok {
			r[k] = s
		}
	}
	return r
}
func resolveCredentials(env map[string]string, appID, secret, mcp string) (Credentials, string, error) {
	if env["LARK_APP_ID"] != "" || env["LARK_APP_SECRET"] != "" {
		if env["LARK_APP_ID"] == "" || env["LARK_APP_SECRET"] == "" {
			return Credentials{}, "", errors.New("Set both LARK_APP_ID and LARK_APP_SECRET")
		}
		return Credentials{env["LARK_APP_ID"], env["LARK_APP_SECRET"]}, "environment", nil
	}
	if appID != "" && secret != "" {
		return Credentials{appID, secret}, "settings", nil
	}
	if mcp == "" {
		return Credentials{}, "", nil
	}
	b, e := readBounded(mcp, 1024*1024)
	if e != nil {
		return Credentials{}, "", e
	}
	var c struct {
		Servers map[string]struct {
			Args []string          `json:"args"`
			Env  map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	if e = json.Unmarshal(b, &c); e != nil {
		return Credentials{}, "", fmt.Errorf("Invalid MCP configuration: %w", e)
	}
	server, ok := c.Servers["lark"]
	if !ok {
		return Credentials{}, "", nil
	}
	argument := func(flags ...string) string {
		for _, flag := range flags {
			for i, s := range server.Args {
				if s == flag && i+1 < len(server.Args) {
					return server.Args[i+1]
				}
			}
		}
		return ""
	}
	id, ok := server.Env["LARK_APP_ID"]
	if !ok {
		id = argument("-a", "--app-id")
	}
	sec, ok := server.Env["LARK_APP_SECRET"]
	if !ok {
		sec = argument("-s", "--app-secret")
	}
	if id == "" || sec == "" {
		return Credentials{}, "", errors.New("Selected MCP config has no supported lark application credentials")
	}
	return Credentials{id, sec}, "mcp-config", nil
}
func readBounded(path string, maximum int64) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, errors.New("invalid or oversized file")
	}
	b, e := io.ReadAll(io.LimitReader(f, maximum+1))
	if int64(len(b)) > maximum {
		return nil, errors.New("file is too large")
	}
	return b, e
}
