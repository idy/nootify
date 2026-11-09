package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

const maxManifest = 1 << 20
const maxArtifact = 512 << 20

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Feed URLs and every redirect stay on the configured HTTPS origin. GitHub
// releases additionally use these exact first-party download/CDN hosts.
func allowedURL(raw, manifest string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid update URL")
	}
	base, err := url.Parse(manifest)
	if err != nil {
		return errors.New("invalid manifest URL")
	}
	valid := func(v *url.URL) bool {
		host := strings.ToLower(v.Hostname())
		return v.Scheme == "https" && v.Opaque == "" && v.User == nil && v.Fragment == "" && host != "" &&
			(v.Port() == "" || v.Port() == "443") && net.ParseIP(host) == nil && host != "localhost" && !strings.HasSuffix(host, ".localhost") && !strings.HasSuffix(host, ".local")
	}
	if !valid(u) || !valid(base) {
		return errors.New("update URL must use a trusted HTTPS host without credentials or fragments")
	}
	if strings.EqualFold(u.Hostname(), base.Hostname()) {
		return nil
	}
	if strings.EqualFold(base.Hostname(), "github.com") {
		switch strings.ToLower(u.Hostname()) {
		case "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com":
			return nil
		}
	}
	return errors.New("update URL host is outside the release origin")
}

func newHTTPClient(manifest string) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = checkTimeout
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.MaxResponseHeaderBytes = 64 << 10
	return &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many update redirects")
		}
		return allowedURL(req.URL.String(), manifest)
	}}
}

func (m *Manager) get(ctx context.Context, raw string) (*http.Response, error) {
	if err := allowedURL(raw, m.options.ManifestURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, errors.New("invalid update request")
	}
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "Nootify-Updater/"+m.options.Version)
	response, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("update request failed: %w", err)
	}
	if response.Request == nil || response.Request.URL == nil {
		response.Body.Close()
		return nil, errors.New("update response has no URL")
	}
	if err = allowedURL(response.Request.URL.String(), m.options.ManifestURL); err != nil {
		response.Body.Close()
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fmt.Errorf("update server returned HTTP %d", response.StatusCode)
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		response.Body.Close()
		return nil, errors.New("unexpected update content encoding")
	}
	return response, nil
}

func (m *Manager) fetchRelease(ctx context.Context) (*release, error) {
	current, err := normalizedVersion(m.options.Version)
	if err != nil {
		return nil, fmt.Errorf("current version: %w", err)
	}
	response, err := m.get(ctx, m.options.ManifestURL)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(&contextReader{ctx: ctx, reader: response.Body}, maxManifest+1))
	if err != nil {
		return nil, fmt.Errorf("read release manifest: %w", err)
	}
	if len(data) > maxManifest {
		return nil, errors.New("release manifest exceeds size limit")
	}
	var feed struct {
		Version   string `json:"version"`
		Platforms map[string]struct {
			URL       string `json:"url"`
			Signature string `json:"signature"`
		} `json:"platforms"`
	}
	if err = json.Unmarshal(data, &feed); err != nil {
		return nil, errors.New("invalid release manifest JSON")
	}
	version, err := normalizedVersion(feed.Version)
	if err != nil {
		return nil, err
	}
	if semver.Compare(version, current) <= 0 {
		return nil, nil
	}
	entry, ok := feed.Platforms[m.options.Platform]
	if !ok && m.options.Platform == "windows-x86_64-nsis" {
		entry, ok = feed.Platforms["windows-x86_64"]
	}
	if !ok {
		return nil, errors.New("release has no artifact for this platform")
	}
	if err = allowedURL(entry.URL, m.options.ManifestURL); err != nil {
		return nil, err
	}
	if _, err = parseSignature(entry.Signature); err != nil {
		return nil, err
	}
	if _, err = parsePublicKey(m.options.PublicKey); err != nil {
		return nil, err
	}
	return &release{Version: strings.TrimPrefix(version, "v"), URL: entry.URL, Signature: entry.Signature}, nil
}

type download struct{ directory, path string }

func (m *Manager) download(ctx context.Context, update release) (_ download, resultErr error) {
	response, err := m.get(ctx, update.URL)
	if err != nil {
		return download{}, err
	}
	defer response.Body.Close()
	if response.ContentLength > maxArtifact {
		return download{}, errors.New("update artifact exceeds size limit")
	}
	parent, prefix := "", "nootify-update-"
	if m.options.Platform == "windows-x86_64-nsis" {
		parent, err = m.installerCache()
		if err != nil {
			return download{}, err
		}
		if err = os.MkdirAll(parent, 0700); err != nil {
			return download{}, err
		}
		prefix = "installer-"
	}
	directory, err := os.MkdirTemp(parent, prefix)
	if err != nil {
		return download{}, err
	}
	defer func() {
		if resultErr != nil {
			_ = os.RemoveAll(directory)
		}
	}()
	name := "Nootify.app.tar.gz"
	if m.options.Platform == "windows-x86_64-nsis" {
		name = installerName
	}
	path := filepath.Join(directory, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return download{}, err
	}
	defer file.Close()
	var total *uint64
	if response.ContentLength > 0 {
		n := uint64(response.ContentLength)
		total = &n
	}
	var received uint64
	var shown uint64 = ^uint64(0)
	buffer := make([]byte, 64<<10)
	reader := io.LimitReader(response.Body, maxArtifact+1)
	for {
		if err = ctx.Err(); err != nil {
			return download{}, err
		}
		n, readErr := reader.Read(buffer)
		if n > 0 {
			received += uint64(n)
			if received > maxArtifact {
				return download{}, errors.New("update artifact exceeds size limit")
			}
			if total != nil && received > *total {
				return download{}, errors.New("update artifact exceeds announced length")
			}
			if _, err = file.Write(buffer[:n]); err != nil {
				return download{}, fmt.Errorf("write update: %w", err)
			}
			step := progressStep(received, total)
			if shown != step {
				shown = step
				m.publish("downloading", received, total, nil)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return download{}, fmt.Errorf("download update: %w", readErr)
		}
	}
	if received == 0 || total != nil && received != *total {
		return download{}, errors.New("update artifact is empty or truncated")
	}
	if err = file.Sync(); err != nil {
		return download{}, err
	}
	if err = file.Close(); err != nil {
		return download{}, err
	}
	return download{directory: directory, path: path}, nil
}
