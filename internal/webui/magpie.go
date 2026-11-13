package webui

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/semver"
)

const (
	magpiePrefix        = "vendor/magpie/"
	magpieMetadataURL   = "https://data.jsdelivr.com/v1/package/"
	magpieCDNURL        = "https://cdn.jsdelivr.net/gh/idy/magpie-design-system@"
	magpieCheckInterval = 6 * time.Hour
	magpieMaxBundle     = 16 * 1024 * 1024
	magpieMaxFile       = 4 * 1024 * 1024
)

type magpieEntry struct {
	Name string `json:"name"`
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}
type magpieManifest struct {
	Version string        `json:"version"`
	Files   []magpieEntry `json:"files"`
}
type magpieBundle struct {
	Manifest magpieManifest    `json:"manifest"`
	Files    map[string][]byte `json:"files"`
}

// magpieAssets keeps complete releases together. Versioned local URLs pin CSS
// imports, fonts and icons to one release, even while a background update lands.
type magpieAssets struct {
	bundled             fs.FS
	baseline            magpieManifest
	dir                 string
	client              *http.Client
	metadataURL, cdnURL string
	mu                  sync.RWMutex
	version             string
	bundles             map[string]*magpieBundle
}

// NewMagpieAssets serves the bundled release immediately, restores newer verified
// downloads, then checks jsDelivr in the background. Failure never blocks the UI.
// The caller owns ctx; cancelling it stops both downloads and periodic checks.
func NewMagpieAssets(ctx context.Context, bundled fs.FS, cacheDir string) (fs.FS, func()) {
	if bundled == nil || cacheDir == "" {
		return bundled, func() {}
	}
	data, err := fs.ReadFile(bundled, magpiePrefix+"manifest.json")
	var manifest magpieManifest
	if err != nil || json.Unmarshal(data, &manifest) != nil || !stableMagpieVersion(manifest.Version) || len(manifest.Files) == 0 {
		return bundled, func() {}
	}
	a := &magpieAssets{bundled: bundled, baseline: manifest, dir: cacheDir,
		client: &http.Client{Timeout: 20 * time.Second}, metadataURL: magpieMetadataURL, cdnURL: magpieCDNURL,
		version: manifest.Version, bundles: make(map[string]*magpieBundle)}
	a.restore()
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); a.run(ctx) }()
	return a, func() { cancel(); <-done }
}

func stableMagpieVersion(version string) bool {
	return strings.HasPrefix(version, "v") && semver.IsValid(version) && semver.Canonical(version) == version && semver.Prerelease(version) == "" && semver.Build(version) == ""
}

func magpieAssetName(name string) bool {
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\?#%:") {
		return false
	}
	if name == "LICENSE" {
		return true
	}
	if !strings.HasPrefix(name, "css/") && !strings.HasPrefix(name, "fonts/") && !strings.HasPrefix(name, "icons/") {
		return false
	}
	switch path.Ext(name) {
	case ".css", ".svg", ".woff", ".woff2", ".ttf", ".otf", ".txt", ".md", ".json":
		return true
	case "":
		return path.Base(name) == "LICENSE"
	}
	return false
}

func (a *magpieAssets) resolveAsset(name string) string {
	if !strings.HasPrefix(name, magpiePrefix) || strings.HasPrefix(strings.TrimPrefix(name, magpiePrefix), "@") {
		return name
	}
	a.mu.RLock()
	version := a.version
	a.mu.RUnlock()
	resolved := magpiePrefix + "@" + version + "/" + strings.TrimPrefix(name, magpiePrefix)
	file, err := a.Open(resolved)
	if err != nil {
		return name
	}
	_ = file.Close()
	return resolved
}

func (a *magpieAssets) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	if !strings.HasPrefix(name, magpiePrefix) {
		return a.bundled.Open(name)
	}
	relative := strings.TrimPrefix(name, magpiePrefix)
	a.mu.RLock()
	version := a.version
	if strings.HasPrefix(relative, "@") {
		var ok bool
		version, relative, ok = strings.Cut(relative[1:], "/")
		if !ok || !stableMagpieVersion(version) {
			a.mu.RUnlock()
			return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
		}
	}
	bundle := a.bundles[version]
	a.mu.RUnlock()
	if version == a.baseline.Version {
		return a.bundled.Open(magpiePrefix + relative)
	}
	if bundle != nil {
		data, ok := bundle.Files[relative]
		if relative == "manifest.json" {
			data, _ = json.Marshal(bundle.Manifest)
			ok = true
		}
		if ok {
			return &magpieFile{Reader: bytes.NewReader(data), name: path.Base(relative), size: int64(len(data))}, nil
		}
	}
	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

type magpieFile struct {
	*bytes.Reader
	name string
	size int64
}

func (f *magpieFile) Close() error               { return nil }
func (f *magpieFile) Stat() (fs.FileInfo, error) { return magpieInfo{f.name, f.size}, nil }

type magpieInfo struct {
	name string
	size int64
}

func (i magpieInfo) Name() string       { return i.name }
func (i magpieInfo) Size() int64        { return i.size }
func (i magpieInfo) Mode() fs.FileMode  { return 0444 }
func (i magpieInfo) ModTime() time.Time { return time.Time{} }
func (i magpieInfo) IsDir() bool        { return false }
func (i magpieInfo) Sys() any           { return nil }

func (a *magpieAssets) run(ctx context.Context) {
	check := func() {
		deadline, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		if err := a.update(deadline); err != nil && ctx.Err() == nil {
			log.Printf("magpie: CDN update unavailable; keeping local assets: %v", err)
		}
	}
	check()
	ticker := time.NewTicker(magpieCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

func (a *magpieAssets) fetch(ctx context.Context, target string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	response, err := a.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("CDN status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("CDN response exceeds asset limit")
	}
	return data, nil
}

func (a *magpieAssets) update(ctx context.Context) error {
	data, err := a.fetch(ctx, a.metadataURL+"resolve/gh/idy/magpie-design-system@latest", 4096)
	if err != nil {
		return err
	}
	var latest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &latest) != nil {
		return errors.New("invalid CDN version response")
	}
	version := "v" + strings.TrimPrefix(latest.Version, "v")
	if !stableMagpieVersion(version) {
		return errors.New("CDN did not resolve a stable version")
	}
	a.mu.RLock()
	current := a.version
	a.mu.RUnlock()
	if semver.Compare(version, current) <= 0 {
		return nil
	}
	data, err = a.fetch(ctx, a.metadataURL+"gh/idy/magpie-design-system@"+version+"/flat", 1024*1024)
	if err != nil {
		return err
	}
	var manifest magpieManifest
	if json.Unmarshal(data, &manifest) != nil {
		return errors.New("invalid CDN file manifest")
	}
	manifest.Version = version
	files := manifest.Files[:0]
	for _, file := range manifest.Files {
		file.Name = strings.TrimPrefix(file.Name, "/")
		if magpieAssetName(file.Name) {
			files = append(files, file)
		}
	}
	manifest.Files = files
	if err := a.validateManifest(manifest); err != nil {
		return err
	}
	bundle := &magpieBundle{Manifest: manifest, Files: make(map[string][]byte)}
	for _, file := range manifest.Files {
		// Escape each segment without changing the upstream relative directory tree.
		segments := strings.Split(file.Name, "/")
		for i := range segments {
			segments[i] = url.PathEscape(segments[i])
		}
		data, err := a.fetch(ctx, a.cdnURL+version+"/"+strings.Join(segments, "/"), file.Size)
		if err != nil {
			return fmt.Errorf("%s: %w", file.Name, err)
		}
		if !validMagpieFile(data, file) {
			return fmt.Errorf("%s: CDN checksum or size mismatch", file.Name)
		}
		bundle.Files[file.Name] = data
	}
	if err := a.save(bundle); err != nil {
		return err
	}
	a.mu.Lock()
	a.bundles[version] = bundle
	if semver.Compare(version, a.version) > 0 {
		a.version = version
	}
	a.mu.Unlock()
	log.Printf("magpie: downloaded %s from CDN; available on next page load", version)
	return nil
}

func (a *magpieAssets) validateManifest(manifest magpieManifest) error {
	if !stableMagpieVersion(manifest.Version) || len(manifest.Files) == 0 || len(manifest.Files) > 256 {
		return errors.New("invalid Magpie manifest")
	}
	seen := make(map[string]bool)
	var total int64
	for _, file := range manifest.Files {
		hash, err := base64.StdEncoding.DecodeString(file.Hash)
		if !magpieAssetName(file.Name) || seen[file.Name] || file.Size < 1 || file.Size > magpieMaxFile || err != nil || len(hash) != sha256.Size {
			return fmt.Errorf("invalid Magpie manifest entry: %s", file.Name)
		}
		seen[file.Name] = true
		total += file.Size
	}
	if total > magpieMaxBundle {
		return errors.New("Magpie bundle exceeds size limit")
	}
	for _, file := range a.baseline.Files {
		// Preserve the CSS entry points and icons the application uses. Font
		// filenames may change; each release supplies its own fonts.css and files.
		required := file.Name == "LICENSE" || strings.HasPrefix(file.Name, "css/") && path.Ext(file.Name) == ".css" || strings.HasPrefix(file.Name, "icons/") && path.Ext(file.Name) == ".svg"
		if required && !seen[file.Name] {
			return fmt.Errorf("Magpie release omits required asset: %s", file.Name)
		}
	}
	return nil
}

func validMagpieFile(data []byte, file magpieEntry) bool {
	hash := sha256.Sum256(data)
	return int64(len(data)) == file.Size && base64.StdEncoding.EncodeToString(hash[:]) == file.Hash
}

func (a *magpieAssets) save(bundle *magpieBundle) error {
	if a.dir == "" {
		return errors.New("Magpie cache directory is unavailable")
	}
	if err := os.MkdirAll(a.dir, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(bundle)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(a.dir, ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	// Immutable version files avoid replacing an open file on Windows. A racing
	// writer can only have downloaded this same pinned release.
	return os.Rename(file.Name(), filepath.Join(a.dir, bundle.Manifest.Version+".json"))
}

func (a *magpieAssets) restore() {
	entries, _ := os.ReadDir(a.dir)
	for _, entry := range entries {
		version := strings.TrimSuffix(entry.Name(), ".json")
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !stableMagpieVersion(version) || semver.Compare(version, a.baseline.Version) <= 0 {
			continue
		}
		file, err := os.Open(filepath.Join(a.dir, entry.Name()))
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(file, 2*magpieMaxBundle+1))
		file.Close()
		if err != nil || len(data) > 2*magpieMaxBundle {
			continue
		}
		var bundle magpieBundle
		if json.Unmarshal(data, &bundle) != nil || bundle.Manifest.Version != version || a.validateManifest(bundle.Manifest) != nil || len(bundle.Files) != len(bundle.Manifest.Files) {
			continue
		}
		valid := true
		for _, asset := range bundle.Manifest.Files {
			if !validMagpieFile(bundle.Files[asset.Name], asset) {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		a.bundles[version] = &bundle
		if semver.Compare(version, a.version) > 0 {
			a.version = version
		}
	}
}
