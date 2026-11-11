package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/idy/nootify/internal/storage"
)

// Options identifies an exact installation. Drain is a receipt from an owned,
// successfully unloaded launchd job whose original process still needs to exit.
type Options struct {
	StateDir   string
	Port       int
	MCPConfig  string
	Executable string
	Drain      json.RawMessage
}
type Result struct {
	Installed  bool   `json:"installed"`
	Running    *bool  `json:"running,omitempty"`
	Enabled    *bool  `json:"enabled,omitempty"`
	WasRunning *bool  `json:"was_running,omitempty"`
	Status     string `json:"status,omitempty"`
	Task       string `json:"task,omitempty"`
	Plist      string `json:"plist,omitempty"`
}
type UnloadedError struct {
	Cause   error
	Process drainProcess
}

func (e *UnloadedError) Error() string { return e.Cause.Error() }
func (e *UnloadedError) Unwrap() error { return e.Cause }

// Failure is the CLI's structured error. Only UnloadedError grants drain recovery.
func Failure(err error) map[string]any {
	result := map[string]any{"error": err.Error()}
	var unloaded *UnloadedError
	if errors.As(err, &unloaded) {
		result["service_unloaded"] = true
		result["service_process"] = unloaded.Process
	}
	return result
}
func normalize(options Options) (Options, error) {
	if options.StateDir == "" {
		options.StateDir = storage.DefaultDir()
	}
	var err error
	options.StateDir, err = filepath.Abs(options.StateDir)
	if err != nil {
		return options, err
	}
	if options.Executable == "" {
		options.Executable, err = os.Executable()
		if err != nil {
			return options, err
		}
	}
	options.Executable, err = filepath.Abs(options.Executable)
	if err != nil {
		return options, err
	}
	if resolved, e := filepath.EvalSymlinks(options.Executable); e == nil {
		options.Executable = resolved
	}
	if options.MCPConfig != "" {
		options.MCPConfig, err = filepath.Abs(options.MCPConfig)
		if err != nil {
			return options, err
		}
	}
	if options.Port == 0 {
		options.Port = 9417
	}
	if options.Port < 1 || options.Port > 65535 {
		return options, errors.New("invalid service port")
	}
	for _, value := range []string{options.Executable, options.StateDir, options.MCPConfig} {
		if strings.ContainsAny(value, "\x00\r\n") {
			return options, errors.New("invalid service path")
		}
	}
	return options, nil
}

// Manage is independent of HTTP credentials: initial install and recovery of a
// stopped service must prove ownership using the OS registration itself.
func Manage(ctx context.Context, action string, options Options) (any, error) {
	switch action {
	case "install", "start", "restart", "stop", "uninstall", "status", "enable", "disable":
	default:
		return nil, errors.New("invalid background service action")
	}
	options, err := normalize(options)
	if err != nil {
		return nil, err
	}
	if len(options.Drain) > 0 && (runtime.GOOS != "darwin" || action != "start" && action != "restart" && action != "stop") {
		return nil, errors.New("service drain recovery requires macOS service-start, service-restart or service-stop")
	}
	if runtime.GOOS == "windows" {
		return manageWindows(ctx, action, options)
	}
	if runtime.GOOS != "darwin" {
		return nil, errors.New("background service management requires macOS or Windows")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return manageLaunchd(ctx, action, options, launchdRuntime{home: home, uid: os.Getuid(), run: Run, shutdownTimeout: 30 * time.Second})
}
func boolPointer(value bool) *bool { return &value }
func serviceArguments(options Options, managed bool) []string {
	args := []string{"serve"}
	if managed {
		args = append(args, "--service-managed")
	}
	args = append(args, "--state-dir", options.StateDir, "--port", strconv.Itoa(options.Port))
	if options.MCPConfig != "" {
		args = append(args, "--mcp-config", options.MCPConfig)
	}
	return args
}
func assertPortFree(port int) error {
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return fmt.Errorf("port %d is already occupied; stop the existing service before installing or starting Nootify", port)
	}
	return listener.Close()
}
func waitContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
