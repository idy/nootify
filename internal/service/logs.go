package service

import (
	"errors"
	"io"
	"os"
	"strings"
)

// ManagedOutput supplies append-only private log files for a managed Windows
// task, where Task Scheduler does not provide stdout/stderr console handles.
// The caller closes both writers after the service has completely drained.
func ManagedOutput(options Options) (stdout, stderr io.WriteCloser, err error) {
	options, err = normalize(options)
	if err != nil {
		return nil, nil, err
	}
	if err = os.MkdirAll(options.StateDir, 0700); err != nil {
		return nil, nil, err
	}
	info, err := os.Lstat(options.StateDir)
	if err != nil {
		return nil, nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("refusing redirected service log directory")
	}
	root, err := os.OpenRoot(options.StateDir)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()
	open := func(name string) (*os.File, error) {
		info, err := root.Lstat(name)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if err == nil && !info.Mode().IsRegular() {
			return nil, errors.New("refusing redirected or special service log file")
		}
		file, err := root.OpenFile(name, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		if err = file.Chmod(0600); err != nil {
			file.Close()
			return nil, err
		}
		return file, nil
	}
	out, err := open("stdout.log")
	if err != nil {
		return nil, nil, err
	}
	errout, err := open("stderr.log")
	if err != nil {
		out.Close()
		return nil, nil, err
	}
	return out, errout, nil
}

// Background tasks use persisted account settings. An ambient shell or Scheduler
// environment must not inject provider credentials, alternate helpers or proxies.
func managedEnvironment(ambient []string) []string {
	result := make([]string, 0, len(ambient))
	for _, entry := range ambient {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		blocked := false
		for _, prefix := range []string{"NODE_", "LARK_", "SLACK_", "TELEGRAM_", "GITHUB_", "GH_", "CODEX_APP_SERVER_", "OPENCODE_SERVER_", "TS_", "TSNET_", "TAILSCALE_"} {
			if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
				blocked = true
				break
			}
		}
		if key == "NOOTIFY_TSNET_BIN" || key == "NOOTIFY_CORE_BIN" || key == "NOOTIFY_GITHUB_CLIENT_ID" {
			blocked = true
		}
		if !blocked {
			result = append(result, entry)
		}
	}
	return result
}
