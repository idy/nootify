package webui

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

func magpieTestManifest(version string, files map[string][]byte) magpieManifest {
	manifest := magpieManifest{Version: version}
	for name, data := range files {
		hash := sha256.Sum256(data)
		manifest.Files = append(manifest.Files, magpieEntry{Name: name, Hash: base64.StdEncoding.EncodeToString(hash[:]), Size: int64(len(data))})
	}
	return manifest
}

func magpieFixture(t *testing.T) (*magpieAssets, map[string][]byte, *atomic.Int32) {
	t.Helper()
	old := map[string][]byte{"css/magpie.css": []byte("@import './tokens.css';"), "css/tokens.css": []byte(":root{--version:1}"), "fonts/old.woff2": []byte("old font"), "icons/icons.svg": []byte("<svg/>")}
	baseline := magpieTestManifest("v0.4.1", old)
	bundled := fstest.MapFS{"index.html": {Data: []byte("application")}}
	for name, data := range old {
		bundled[magpiePrefix+name] = &fstest.MapFile{Data: data}
	}
	manifestData, _ := json.Marshal(baseline)
	bundled[magpiePrefix+"manifest.json"] = &fstest.MapFile{Data: manifestData}
	files := map[string][]byte{"css/magpie.css": []byte("@import './tokens.css';"), "css/tokens.css": []byte(":root{--version:2}"), "fonts/new.woff2": []byte("new font"), "icons/icons.svg": []byte("<svg>new</svg>")}
	manifest := magpieTestManifest("v0.4.2", files)
	for i := range manifest.Files {
		manifest.Files[i].Name = "/" + manifest.Files[i].Name
	}
	manifestData, _ = json.Marshal(manifest)
	status := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/metadata/resolve/gh/idy/magpie-design-system@latest":
			_, _ = w.Write([]byte(`{"version":"0.4.2"}`))
		case "/metadata/gh/idy/magpie-design-system@v0.4.2/flat":
			_, _ = w.Write(manifestData)
		default:
			if status.Load() != 0 {
				w.WriteHeader(int(status.Load()))
				return
			}
			name := strings.TrimPrefix(r.URL.Path, "/cdn/v0.4.2/")
			if data, ok := files[name]; ok {
				_, _ = w.Write(data)
			} else {
				http.NotFound(w, r)
			}
		}
	}))
	t.Cleanup(server.Close)
	return &magpieAssets{bundled: bundled, baseline: baseline, dir: t.TempDir(), client: server.Client(), metadataURL: server.URL + "/metadata/", cdnURL: server.URL + "/cdn/", version: baseline.Version, bundles: make(map[string]*magpieBundle)}, files, status
}

func TestMagpieDownloadActivatesCompleteReleaseAndRestoresOffline(t *testing.T) {
	a, _, _ := magpieFixture(t)
	if err := a.update(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.version != "v0.4.2" {
		t.Fatalf("release not activated: %s", a.version)
	}
	data, err := fs.ReadFile(a, magpiePrefix+"css/tokens.css")
	if err != nil || !strings.Contains(string(data), "version:2") {
		t.Fatalf("cached CSS: %s %v", data, err)
	}
	if _, err := fs.ReadFile(a, magpiePrefix+"fonts/old.woff2"); !os.IsNotExist(err) {
		t.Fatal("mixed cached release with bundled font")
	}
	restored := &magpieAssets{bundled: a.bundled, baseline: a.baseline, dir: a.dir, version: a.baseline.Version, bundles: make(map[string]*magpieBundle)}
	restored.restore()
	if restored.version != "v0.4.2" {
		t.Fatal("verified disk cache not restored offline")
	}
	data, err = fs.ReadFile(restored, "index.html")
	if err != nil || string(data) != "application" {
		t.Fatal("non-Magpie assets changed")
	}
}

func TestMagpieFailuresKeepBundledOrLastGoodRelease(t *testing.T) {
	for _, failure := range []string{"offline", "corrupt", "missing"} {
		t.Run(failure, func(t *testing.T) {
			a, files, status := magpieFixture(t)
			switch failure {
			case "offline":
				status.Store(http.StatusServiceUnavailable)
			case "corrupt":
				files["css/tokens.css"] = []byte("incorrect bytes")
			case "missing":
				delete(files, "fonts/new.woff2")
			}
			if err := a.update(context.Background()); err == nil {
				t.Fatal("invalid download succeeded")
			}
			if a.version != a.baseline.Version || len(a.bundles) != 0 {
				t.Fatal("partial release activated")
			}
			entries, _ := os.ReadDir(a.dir)
			if len(entries) != 0 {
				t.Fatal("partial release persisted")
			}
		})
	}
	a, _, status := magpieFixture(t)
	if err := a.update(context.Background()); err != nil {
		t.Fatal(err)
	}
	status.Store(503)
	// A stale CDN response never rolls a newer local release back.
	a.version = "v0.5.0"
	if err := a.update(context.Background()); err != nil || a.version != "v0.5.0" {
		t.Fatalf("downgrade: %s %v", a.version, err)
	}
}

func TestMagpieCacheCorruptionFallsBackAndOlderCacheCannotDowngrade(t *testing.T) {
	a, _, _ := magpieFixture(t)
	if err := a.update(context.Background()); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(a.dir, "v0.4.2.json")
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var bundle magpieBundle
	if err = json.Unmarshal(data, &bundle); err != nil {
		t.Fatal(err)
	}
	bundle.Files["css/tokens.css"] = []byte("tampered cache")
	data, _ = json.Marshal(bundle)
	if err = os.WriteFile(filename, data, 0600); err != nil {
		t.Fatal(err)
	}
	a.version = a.baseline.Version
	a.bundles = make(map[string]*magpieBundle)
	a.restore()
	if a.version != a.baseline.Version {
		t.Fatal("corrupt cache activated")
	}
	// Even a valid old release must not supersede a newer packaged baseline.
	bundle.Files["css/tokens.css"] = []byte(":root{--version:2}")
	data, _ = json.Marshal(bundle)
	if err = os.WriteFile(filename, data, 0600); err != nil {
		t.Fatal(err)
	}
	a.baseline.Version = "v0.4.3"
	a.version = a.baseline.Version
	a.restore()
	if a.version != "v0.4.3" {
		t.Fatal("old cache overrode new application bundle")
	}
}

func TestMagpieVersionedLocalURLsKeepImportsOnTheirRelease(t *testing.T) {
	a, _, _ := magpieFixture(t)
	handler := Assets(a)
	initial := httptest.NewRecorder()
	handler.ServeHTTP(initial, httptest.NewRequest("GET", "/ui/vendor/magpie/css/magpie.css", nil))
	oldURL := initial.Header().Get("Location")
	if initial.Code != 307 || oldURL != "/ui/vendor/magpie/@v0.4.1/css/magpie.css" {
		t.Fatalf("unversioned redirect: %d %s", initial.Code, oldURL)
	}
	if err := a.update(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ target, contains string }{
		{"/ui/vendor/magpie/@v0.4.1/css/tokens.css", "version:1"},
		{"/ui/vendor/magpie/@v0.4.2/css/tokens.css", "version:2"},
		{"/ui/vendor/magpie/@v0.4.2/fonts/new.woff2", "new font"},
		{"/ui/vendor/magpie/@v0.4.2/icons/icons.svg", "new"},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", tc.target, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), tc.contains) || w.Header().Get("Content-Security-Policy") != contentPolicy {
			t.Fatalf("%s: %d %s", tc.target, w.Code, w.Body.String())
		}
	}
	for _, target := range []string{"/ui/vendor/magpie/@v9.0.0/css/tokens.css", "/ui/vendor/magpie/@v0.4.2/js/magpie.js", "/ui/vendor/magpie/@v0.4.2/css/../tokens.css"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 404 {
			t.Fatalf("invalid URL %s: %d", target, w.Code)
		}
	}
}

func TestMagpieRejectsUnsafeOrIncompleteManifests(t *testing.T) {
	for _, name := range []string{"css/../secret", "css/x.css?query", "js/magpie.js", "/css/tokens.css", "css/x\\y.css", "icons/x.svg#fragment", "css/x%2fy.css"} {
		if magpieAssetName(name) {
			t.Fatalf("unsafe asset: %s", name)
		}
	}
	for _, version := range []string{"v0.4.2-beta.1", "v0.4.2+build", "v0.4", "latest", "v../../secret"} {
		if stableMagpieVersion(version) {
			t.Fatalf("invalid stable version: %s", version)
		}
	}
	a, _, _ := magpieFixture(t)
	for _, files := range []map[string][]byte{{"css/magpie.css": []byte("missing tokens")}, {"js/magpie.js": []byte("script")}} {
		if a.validateManifest(magpieTestManifest("v0.4.2", files)) == nil {
			t.Fatal("incomplete manifest accepted")
		}
	}
}

func TestMagpieConstructorRestoresOfflineCacheAndJoinsWorker(t *testing.T) {
	a, _, _ := magpieFixture(t)
	if err := a.update(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Keep the public constructor's background check offline.
	assets, stop := NewMagpieAssets(ctx, a.bundled, a.dir)
	data, err := fs.ReadFile(assets, magpiePrefix+"css/tokens.css")
	if err != nil || !strings.Contains(string(data), "version:2") {
		t.Fatalf("constructor did not restore cached CSS: %s %v", data, err)
	}
	done := make(chan struct{})
	go func() { stop(); stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("asset worker did not join")
	}
}

func TestMagpieCancellationStopsDownloadWithoutPublishing(t *testing.T) {
	a, _, _ := magpieFixture(t)
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() }))
	defer server.Close()
	a.metadataURL = server.URL + "/"
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.update(ctx) }()
	<-entered
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled download succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("download ignored cancellation")
	}
	if a.version != a.baseline.Version {
		t.Fatal("cancelled download activated")
	}
}
