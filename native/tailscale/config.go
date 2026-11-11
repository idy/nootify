package tailscale

import (
	"errors"
	"flag"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"

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
	if !validStateDir(cfg.stateDir) {
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

func validStateDir(path string) bool {
	clean := filepath.Clean(path)
	return filepath.IsAbs(path) && filepath.Dir(clean) != clean
}

const stateLockName = ".nootify-tsnet.lock"

var errStateLocked = errors.New("state_locked")
