package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

type localSession struct {
	PublicSession
	path string
	pid  uint32
}
type runtimeRecord struct {
	PID           uint32 `json:"pid"`
	SessionID     string `json:"sessionId"`
	HostSessionID string `json:"hostSessionId"`
	SocketPath    string `json:"messagingSocketPath"`
	Name          string `json:"name"`
}
type desktopRecord struct {
	SessionID    string `json:"sessionId"`
	CLISessionID string `json:"cliSessionId"`
	Title        string `json:"title"`
	Archived     *bool  `json:"isArchived"`
}

func readJSON(path string, v any) error {
	if info, err := os.Stat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("Invalid local session metadata file")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > 12*1024*1024 {
		return fmt.Errorf("Session metadata exceeds the read limit")
	}
	data, err := io.ReadAll(io.LimitReader(f, 12*1024*1024+1))
	if err != nil {
		return err
	}
	if len(data) > 12*1024*1024 {
		return fmt.Errorf("Session metadata exceeds the read limit")
	}
	if len(strings.TrimSpace(string(data))) == 0 || strings.TrimSpace(string(data))[0] != '{' {
		return fmt.Errorf("Invalid local session metadata")
	}
	return json.Unmarshal(data, v)
}
func entries(path string) ([]os.DirEntry, error) {
	e, err := os.ReadDir(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return e, err
}
func (s *Service) desktopRoots() []string {
	base := envPath("XDG_CONFIG_HOME", filepath.Join(s.options.Home, ".config"))
	switch runtime.GOOS {
	case "darwin":
		base = filepath.Join(s.options.Home, "Library", "Application Support")
	case "windows":
		base = envPath("APPDATA", filepath.Join(s.options.Home, "AppData", "Roaming"))
	}
	return []string{filepath.Join(base, "Claude-3p", "claude-code-sessions"), filepath.Join(base, "Claude", "claude-code-sessions")}
}
func (s *Service) desktopFolders() ([]string, error) {
	result := []string{}
	for _, root := range s.desktopRoots() {
		accounts, err := entries(root)
		if err != nil {
			return nil, err
		}
		for _, account := range accounts {
			if !account.IsDir() {
				continue
			}
			parent := filepath.Join(root, account.Name())
			profiles, err := entries(parent)
			if err != nil {
				return nil, err
			}
			for _, profile := range profiles {
				if profile.IsDir() {
					result = append(result, filepath.Join(parent, profile.Name()))
				}
			}
		}
	}
	return result, nil
}

var runtimeFilename = regexp.MustCompile(`^\d+\.json$`)

func (s *Service) runtimes(id, adapter string) ([]runtimeRecord, error) {
	dir := filepath.Join(envPath("CLAUDE_CONFIG_DIR", filepath.Join(s.options.Home, ".claude")), "sessions")
	files, err := entries(dir)
	if err != nil {
		return nil, err
	}
	result := []runtimeRecord{}
	for _, file := range files {
		if !file.Type().IsRegular() || !runtimeFilename.MatchString(file.Name()) {
			continue
		}
		var r runtimeRecord
		if readJSON(filepath.Join(dir, file.Name()), &r) != nil {
			continue
		}
		if adapter == "claude-desktop" {
			if r.HostSessionID != id {
				continue
			}
		} else {
			if r.SessionID != id || r.HostSessionID != "" {
				continue
			}
		}
		if r.PID == 0 || !processAlive(r.PID) || checkSocket(r.SocketPath) != nil {
			continue
		}
		result = append(result, r)
	}
	return result, nil
}
func (s *Service) inspectLocal(id, adapter string) (*localSession, error) {
	if !validID(id) {
		return nil, nil
	}
	runtimes, err := s.runtimes(id, adapter)
	if err != nil {
		return nil, err
	}
	var metadata *desktopRecord
	corrupt := false
	result := &localSession{PublicSession: PublicSession{SessionID: id, Adapter: adapter, HostID: s.host, SessionName: id, Availability: "unknown"}}
	if adapter == "claude-desktop" {
		folders, err := s.desktopFolders()
		if err != nil {
			return nil, err
		}
		for _, folder := range folders {
			var r desktopRecord
			err = readJSON(filepath.Join(folder, id+".json"), &r)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				corrupt = true
				continue
			}
			if r.SessionID != id || metadata != nil {
				return result, nil
			}
			metadata = &r
		}
		if metadata == nil && !corrupt {
			return nil, nil
		}
	}
	var live *runtimeRecord
	for _, r := range runtimes {
		if metadata == nil || metadata.CLISessionID == "" || metadata.CLISessionID == r.SessionID {
			copy := r
			live = &copy
			break
		}
	}
	if adapter == "claude-code" && live == nil {
		return nil, nil
	}
	if live != nil && live.Name != "" {
		result.SessionName = live.Name
	}
	if metadata != nil && metadata.Title != "" {
		result.SessionName = metadata.Title
	}
	switch {
	case adapter == "claude-desktop" && (corrupt || metadata == nil || metadata.Archived == nil):
		result.Availability = "unknown"
	case metadata != nil && metadata.Archived != nil && *metadata.Archived:
		result.Availability = "archived"
	case live != nil:
		result.Availability = "active"
		result.path = live.SocketPath
		result.pid = live.PID
	default:
		result.Availability = "offline"
	}
	return result, nil
}
