package service

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// OwnedUI is an independent trusted asset gateway, never the replaceable daemon's HTTP origin.
// Its process belongs to this desktop; EOF closes it and exit revokes its navigation origin.
type OwnedUI struct {
	URL   string
	cmd   *exec.Cmd
	input io.WriteCloser
	done  chan struct{}
	once  sync.Once
}

func (u *OwnedUI) Alive() bool {
	select {
	case <-u.done:
		return false
	default:
		return true
	}
}
func (u *OwnedUI) Close() {
	u.once.Do(func() {
		_ = u.input.Close()
		select {
		case <-u.done:
		case <-time.After(2 * time.Second):
			_ = u.cmd.Process.Kill()
			<-u.done
		}
	})
}

var ownerRoutePattern = regexp.MustCompile(`^#/[a-z-]+(?:/[a-z-]+)?$`)
var capsulePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$`)

func uiOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Port() == "9417" || u.User != nil || u.EscapedPath() != "/" || u.RawQuery != "" || u.Opaque != "" {
		return "", errors.New("invalid owned UI gateway origin")
	}
	q, err := url.ParseQuery(u.Fragment)
	if err != nil || len(q) != 2 || len(q["nootify-ui"]) != 1 || !capsulePattern.MatchString(q.Get("nootify-ui")) || len(q["route"]) != 1 || !ownerRoutePattern.MatchString(q.Get("route")) {
		return "", errors.New("invalid owned UI gateway capability")
	}
	return u.Scheme + "://" + u.Host + "/", nil
}

func startOwnedUI(ctx context.Context, command Command) (*OwnedUI, error) {
	cmd := exec.CommandContext(ctx, command.Path, command.Args...)
	cmd.Dir, cmd.Env = command.Dir, command.Env
	hideConsole(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard // Bootstrap failures must not put keys or authorization URLs in logs.
	if err = cmd.Start(); err != nil {
		_ = input.Close()
		return nil, err
	}
	u := &OwnedUI{cmd: cmd, input: input, done: make(chan struct{})}
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 4096)
		if scanner.Scan() {
			ready <- scanner.Text()
		}
		_, _ = io.Copy(io.Discard, output)
	}()
	go func() { _ = cmd.Wait(); close(u.done) }()
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	select {
	case line := <-ready:
		var response struct {
			URL string `json:"url"`
		}
		if json.Unmarshal([]byte(line), &response) != nil {
			u.Close()
			return nil, errors.New("invalid owned UI gateway response")
		}
		if _, err := uiOrigin(response.URL); err != nil {
			u.Close()
			return nil, err
		}
		u.URL = response.URL
		if !u.Alive() {
			u.Close()
			return nil, errors.New("owned UI gateway stopped before navigation")
		}
		return u, nil
	case <-u.done:
		_ = input.Close()
		return nil, errors.New("owned UI authorization is unavailable")
	case <-ctx.Done():
		u.Close()
		return nil, ctx.Err()
	case <-timer.C:
		u.Close()
		return nil, errors.New("owned UI gateway startup timed out")
	}
}

// Development UI uses checkout code and the developer's Node runtime, while Bundle
// remains nil so production service controls/install/update remain unavailable.
func developmentUI() *Bundled {
	cwd, err := os.Getwd()
	if err != nil {
		return nil
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return nil
	}
	for _, root := range []string{cwd, filepath.Dir(cwd)} {
		cli := filepath.Join(root, "dist", "src", "cli.js")
		if info, err := os.Stat(cli); err == nil && info.Mode().IsRegular() {
			if source, err := os.Stat(filepath.Join(root, "src", "cli.ts")); err == nil && source.Mode().IsRegular() {
				return &Bundled{node, cli}
			}
		}
	}
	return nil
}
func (m *Manager) OpenUI(ctx context.Context, currentRoute string) (*OwnedUI, error) {
	bundle := m.Bundle
	if bundle == nil {
		bundle = m.uiBundle()
	}
	if bundle == nil {
		return nil, errors.New("build the development service UI before starting the desktop")
	}
	route := "#/logs"
	if ownerRoutePattern.MatchString(currentRoute) {
		route = currentRoute
	}
	args := []string{bundle.CLI, "ui-url", "--ui-managed", "--ui-route", route}
	return m.uiLaunch(ctx, Command{Path: bundle.Node, Args: args, Dir: m.Home, Env: cleanEnvironment(m.platform, m.Home, os.Environ())})
}
func (u *OwnedUI) Origin() string { origin, _ := uiOrigin(u.URL); return strings.TrimSpace(origin) }
