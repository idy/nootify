package pulls

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/idy/nootify/internal/privatepath"
)

type jsonRaw = json.RawMessage

var marshal = json.Marshal
var unmarshal = json.Unmarshal

type Config struct {
	Authors             []string `json:"authors"`
	OwnedOwners         []string `json:"ownedOwners"`
	UpstreamOwners      []string `json:"upstreamOwners"`
	ExcludeRepositories []string `json:"excludeRepositories"`
	ScanRoots           []string `json:"scanRoots"`
	MaxScanDepth        int      `json:"maxScanDepth"`
	MaxSearchPages      int      `json:"maxSearchPages"`
	MaxForkPages        int      `json:"maxForkPages"`
	MaxUpstreamPages    int      `json:"maxUpstreamPages"`
	FollowDefault       string   `json:"followDefault"`
}

var loginPattern = regexp.MustCompile(`(?i)^[a-z\d][a-z\d-]*(?:\[bot\])?$`)

func ParseConfig(value []byte, home string) (Config, error) {
	var input map[string]json.RawMessage
	if err := json.Unmarshal(value, &input); err != nil || input == nil {
		return Config{}, errors.New("Pulls configuration must be a JSON object.")
	}
	config := Config{MaxScanDepth: 6, MaxSearchPages: 10, MaxForkPages: 3, MaxUpstreamPages: 10, FollowDefault: "involved"}
	for _, f := range []struct {
		name    string
		dst     *[]string
		maximum int
		valid   func(string) bool
		message string
	}{
		{"authors", &config.Authors, 100, loginPattern.MatchString, "authors must contain at most 100 GitHub logins."},
		{"ownedOwners", &config.OwnedOwners, 100, loginPattern.MatchString, "ownedOwners must contain at most 100 GitHub logins."},
		{"upstreamOwners", &config.UpstreamOwners, 100, loginPattern.MatchString, "upstreamOwners must contain at most 100 GitHub logins."},
		{"excludeRepositories", &config.ExcludeRepositories, 1000, repositoryName, "excludeRepositories must contain owner/repository names."},
		{"scanRoots", &config.ScanRoots, 100, func(v string) bool { return filepath.IsAbs(expandHome(v, home)) }, "scanRoots must contain absolute paths or ~/ paths."},
	} {
		v := input[f.name]
		if len(v) == 0 || string(v) == "null" {
			*f.dst = []string{}
			continue
		}
		var raw []json.RawMessage
		if json.Unmarshal(v, &raw) != nil || raw == nil || len(raw) > f.maximum {
			return Config{}, errors.New(f.message)
		}
		list := []string{}
		for _, r := range raw {
			var s string
			if json.Unmarshal(r, &s) != nil || s == "" || !f.valid(s) {
				return Config{}, errors.New(f.message)
			}
			list = append(list, s)
		}
		if f.name == "scanRoots" {
			*f.dst = uniqueExact(list)
		} else {
			*f.dst = unique(list)
		}
	}
	for i, s := range config.ScanRoots {
		config.ScanRoots[i] = filepath.Clean(expandHome(s, home))
	}
	config.ScanRoots = uniqueExact(config.ScanRoots)
	for _, f := range []struct {
		name     string
		dst      *int
		min, max int
	}{{"maxScanDepth", &config.MaxScanDepth, 0, 20}, {"maxSearchPages", &config.MaxSearchPages, 1, 10}, {"maxForkPages", &config.MaxForkPages, 1, 10}, {"maxUpstreamPages", &config.MaxUpstreamPages, 1, 10}} {
		if r := input[f.name]; len(r) > 0 && string(r) != "null" {
			var v float64
			if json.Unmarshal(r, &v) != nil || math.Trunc(v) != v || v < float64(f.min) {
				return Config{}, fmt.Errorf("%s must be an integer >= %d.", f.name, f.min)
			}
			*f.dst = int(math.Min(v, float64(f.max)))
		}
	}
	if r := input["followDefault"]; len(r) > 0 && string(r) != "null" {
		if json.Unmarshal(r, &config.FollowDefault) != nil || (config.FollowDefault != "involved" && config.FollowDefault != "all") {
			return Config{}, errors.New("followDefault must be \"involved\" or \"all\".")
		}
	}
	return config, nil
}
func expandHome(path, home string) string {
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		return filepath.Join(home, path[2:])
	}
	return path
}
func loadConfig(dir, home string) (Config, string, []string, error) {
	path := strings.TrimSpace(os.Getenv("NOOTIFY_PULLS_CONFIG"))
	explicit := path != ""
	if !explicit {
		path = filepath.Join(dir, "pulls.config.json")
	} else {
		path = expandHome(path, home)
		var e error
		path, e = filepath.Abs(path)
		if e != nil {
			return Config{}, path, nil, e
		}
	}
	data, err := readBounded(path, 1024*1024)
	if err != nil {
		if !explicit && errors.Is(err, os.ErrNotExist) {
			c, e := ParseConfig([]byte("{}"), home)
			return c, "defaults", []string{}, e
		}
		return Config{}, path, nil, fmt.Errorf("Cannot read pulls configuration %s: %s", path, safeError(err))
	}
	var input map[string]json.RawMessage
	if json.Unmarshal(data, &input) != nil {
		return Config{}, path, nil, fmt.Errorf("Invalid JSON in pulls configuration %s.", path)
	}
	warnings := []string{}
	if r, ok := input["refreshMinutes"]; ok && string(r) != "5" {
		warnings = append(warnings, "The pulls service refreshes every 5 minutes; legacy refreshMinutes is ignored.")
	}
	c, e := ParseConfig(data, home)
	return c, path, warnings, e
}
func readBounded(path string, maximum int64) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if st.Size() > maximum {
		return nil, fmt.Errorf("file exceeds %d bytes", maximum)
	}
	b, e := io.ReadAll(io.LimitReader(f, maximum+1))
	if int64(len(b)) > maximum {
		return nil, fmt.Errorf("file exceeds %d bytes", maximum)
	}
	return b, e
}
func writePrivate(dir, name string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	b = append(b, '\n')
	if e = privatepath.Protect(dir, true); e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, "."+name+"-*.tmp")
	if e != nil {
		return e
	}
	path := f.Name()
	defer os.Remove(path)
	defer f.Close()
	if e = privatepath.Protect(path, false); e != nil {
		return e
	}
	if _, e = f.Write(b); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(path, filepath.Join(dir, name))
}

var credentialsURL = regexp.MustCompile(`(?i)https?://[^\s/@]+(?::[^\s/@]*)?@`)
var credentialsToken = regexp.MustCompile(`(?i)(?:gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+)`)
var bearerToken = regexp.MustCompile(`(?i)Bearer\s+[^\s"']+`)

func safeError(err error) string {
	if err == nil {
		return ""
	}
	s := credentialsURL.ReplaceAllString(err.Error(), "https://[redacted]@")
	s = credentialsToken.ReplaceAllString(s, "[redacted]")
	s = bearerToken.ReplaceAllString(s, "Bearer [redacted]")
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 700 {
		s = s[:700]
	}
	return s
}
