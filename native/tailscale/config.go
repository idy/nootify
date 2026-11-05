package main

import (
	"errors"
	"flag"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
	"tailscale.com/util/dnsname"
)

type config struct {
	stateDir string
	target   string // validated numeric loopback host:port, without URL syntax
	hostname string
	version  bool
}

func parseArgs(args []string) (config, error) {
	var cfg config
	var target string
	flags := flag.NewFlagSet("nootify-tsnet", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.stateDir, "state-dir", "", "private absolute state directory")
	flags.StringVar(&target, "target", "", "fixed tcp://127.0.0.1:<port> backend")
	flags.StringVar(&cfg.hostname, "hostname", "nootify", "Tailscale device hostname")
	flags.BoolVar(&cfg.version, "version", false, "print embedded Tailscale version")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return config{}, errors.New("invalid_arguments")
	}
	if cfg.version {
		return cfg, nil
	}
	if !filepath.IsAbs(cfg.stateDir) || filepath.Clean(cfg.stateDir) == string(filepath.Separator) {
		return config{}, errors.New("invalid_state_dir")
	}
	cfg.stateDir = filepath.Clean(cfg.stateDir)
	if dnsname.ValidLabel(cfg.hostname) != nil {
		return config{}, errors.New("invalid_hostname")
	}
	var err error
	cfg.target, err = validateTarget(target)
	return cfg, err
}

func validateTarget(raw string) (string, error) {
	port, ok := strings.CutPrefix(raw, "tcp://127.0.0.1:")
	if !ok || port == "" {
		return "", errors.New("invalid_target")
	}
	for _, ch := range port {
		if ch < '0' || ch > '9' {
			return "", errors.New("invalid_target")
		}
	}
	n, err := strconv.ParseUint(port, 10, 16)
	if err != nil || n == 0 {
		return "", errors.New("invalid_target")
	}
	return net.JoinHostPort("127.0.0.1", strconv.FormatUint(n, 10)), nil
}

const stateLockName = ".nootify-tsnet.lock"

var errStateLocked = errors.New("state_locked")

// The stable lock file is never unlinked: tailscaled.state is atomically
// replaced by tsnet, so locking that inode would not exclude another process.
// The caller must keep the returned descriptor open until tsnet.Close returns.
func prepareStateDir(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) == string(filepath.Separator) {
		return nil, errors.New("invalid_state_dir")
	}
	path = filepath.Clean(path)
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	root := os.NewFile(uintptr(fd), path)
	defer root.Close()
	if err := privateStateFile(root, true); err != nil {
		return nil, err
	}

	fd, err = unix.Openat(int(root.Fd()), stateLockName, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	lock := os.NewFile(uintptr(fd), filepath.Join(path, stateLockName))
	locked := false
	defer func() {
		if !locked {
			lock.Close()
		}
	}()
	// Validate before chmod or flock; in particular, never change a linked file.
	if err := privateStateFile(lock, false); err != nil {
		return nil, err
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil, errStateLocked
		}
		return nil, err
	}
	if err := privateStateTree(root); err != nil {
		return nil, err
	}
	locked = true
	return lock, nil
}

// Open children relative to a pinned directory, without following symlinks.
// Chmod uses that same descriptor, so replacing a pathname cannot redirect a
// permission repair to another daemon's credentials or an unrelated file.
func privateStateTree(dir *os.File) error {
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && !entry.Type().IsRegular() {
			return errors.New("unsafe_state_file")
		}
		fd, err := unix.Openat(int(dir.Fd()), entry.Name(), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), entry.Name())
		err = privateStateFile(file, entry.IsDir())
		if err == nil && entry.IsDir() {
			err = privateStateTree(file)
		}
		file.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func privateStateFile(file *os.File, directory bool) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return errors.New("unsafe_state_file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("unsafe_state_owner")
	}
	if info.Mode().IsRegular() && stat.Nlink != 1 {
		return errors.New("unsafe_state_link")
	}
	mode := fs.FileMode(0600)
	if info.IsDir() {
		mode = 0700
	}
	return file.Chmod(mode)
}
