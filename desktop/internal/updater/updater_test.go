package updater

import (
	"bytes"
	"context"
	"debug/pe"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type doerFunc func(*http.Request) (*http.Response, error)

func (f doerFunc) Do(r *http.Request) (*http.Response, error) { return f(r) }
func response(r *http.Request, data []byte) *http.Response {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Request: r}
}
func feedJSON(version, platform, signature string) []byte {
	data, _ := json.Marshal(map[string]any{"version": version, "notes": "test", "pub_date": "2026-11-09T00:00:00Z", "platforms": map[string]any{platform: map[string]any{"url": "https://github.com/idy/nootify/releases/download/v" + version + "/artifact", "signature": signature}}})
	return data
}

func TestURLPolicyAndRedirects(t *testing.T) {
	for _, raw := range []string{"https://github.com/idy/nootify/releases/latest/download/latest.json", "https://release-assets.githubusercontent.com/path?token=value", "https://objects.githubusercontent.com/path", "https://api.github.com/path", "https://github.com:443/path"} {
		if err := allowedURL(raw, DefaultManifestURL); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{"http://github.com/path", "file:///tmp/update", "https://github.com.evil.example/path", "https://github.com@evil.example/path", "https://user:secret@github.com/path", "https://github.com:444/path", "https://127.0.0.1/path", "https://localhost/path", "https://github.com/path#fragment", "//github.com/path", "https://evil.example/path", "https://[::1]/path"} {
		if err := allowedURL(raw, DefaultManifestURL); err == nil {
			t.Fatal("accepted URL", raw)
		}
	}
	if err := allowedURL("https://updates.example/artifact", "https://updates.example/latest.json"); err != nil {
		t.Fatal(err)
	}
	if err := allowedURL("https://github.com/artifact", "https://updates.example/latest.json"); err == nil {
		t.Fatal("custom feed escaped origin")
	}
	client := newHTTPClient(DefaultManifestURL)
	for _, raw := range []string{"https://evil.example/path", "http://github.com/path"} {
		u, _ := url.Parse(raw)
		if err := client.CheckRedirect(&http.Request{URL: u}, nil); err == nil {
			t.Fatal("redirect escaped policy")
		}
	}
	u, _ := url.Parse("https://github.com/path")
	if err := client.CheckRedirect(&http.Request{URL: u}, make([]*http.Request, 10)); err == nil {
		t.Fatal("unbounded redirects")
	}
	m := New(Options{Version: "1.0.0"})
	m.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		res := response(r, []byte("{}"))
		other := r.Clone(r.Context())
		other.URL, _ = url.Parse("https://evil.example/path")
		res.Request = other
		return res, nil
	})
	if _, err := m.get(context.Background(), DefaultManifestURL); err == nil {
		t.Fatal("response URL escaped policy")
	}
}

func TestSemanticVersions(t *testing.T) {
	for _, v := range []string{"1.0.0", "v1.2.3", "1.2.3-beta.1", "1.2.3+build.01", "0.0.0"} {
		if _, err := normalizedVersion(v); err != nil {
			t.Fatal(v, err)
		}
	}
	for _, v := range []string{"", "1", "1.2", "01.2.3", "1.02.3", "1.2.3-01", "vv1.2.3", "1.2.3.4", " 1.2.3", "1.2.3-"} {
		if _, err := normalizedVersion(v); err == nil {
			t.Fatal("accepted version", v)
		}
	}
	public, _, key := syntheticKey(t)
	signature := signedBytes(t, key, []byte("x"))
	for _, tt := range []struct {
		current, next string
		available     bool
	}{{"1.9.9", "1.10.0", true}, {"1.0.0-beta.2", "1.0.0-beta.10", true}, {"1.0.0-beta", "1.0.0", true}, {"1.0.0", "1.0.0-beta", false}, {"1.0.0+one", "1.0.0+two", false}, {"2.0.0", "1.0.0", false}} {
		m := New(Options{Version: tt.current, PublicKey: public, Platform: "windows-x86_64-nsis"})
		m.client = doerFunc(func(r *http.Request) (*http.Response, error) {
			return response(r, feedJSON(tt.next, "windows-x86_64", signature)), nil
		})
		if err := m.Check(context.Background()); err != nil {
			t.Fatal(err)
		}
		if (m.View().Phase == "available") != tt.available {
			t.Fatal(tt, m.View())
		}
	}
}

func TestCheckErrorsRetainPendingAndExactView(t *testing.T) {
	public, _, key := syntheticKey(t)
	signature := signedBytes(t, key, []byte("x"))
	m := New(Options{Version: "1.0.0", PublicKey: public, Platform: "darwin-aarch64"})
	now := time.UnixMilli(1234567)
	m.now = func() time.Time { return now }
	failed := false
	m.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > checkTimeout {
			t.Fatal("check deadline unbounded")
		}
		if failed {
			return nil, errors.New("network failed")
		}
		return response(r, feedJSON("1.1.0", "darwin-aarch64", signature)), nil
	})
	var phases []string
	m.SetListener(func(v View) { phases = append(phases, v.Phase); _ = m.View() })
	if err := m.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	failed = true
	if err := m.Check(context.Background()); err == nil {
		t.Fatal("lost network failure")
	}
	v := m.View()
	if v.Phase != "available" || v.Version == nil || *v.Version != "1.1.0" || v.CheckedAt == nil || *v.CheckedAt != 1234567 || v.Error == nil {
		t.Fatal(v)
	}
	*v.Version = "mutated"
	*v.CheckedAt = 0
	if *m.View().Version != "1.1.0" || *m.View().CheckedAt != 1234567 {
		t.Fatal("view aliases internal state")
	}
	if !reflect.DeepEqual(phases, []string{"idle", "checking", "available", "checking", "available"}) {
		t.Fatal(phases)
	}
	encoded, _ := json.Marshal(New(Options{Version: "1.0.0"}).View())
	var fields map[string]any
	_ = json.Unmarshal(encoded, &fields)
	if len(fields) != 7 || string(encoded) != `{"phase":"idle","current":"1.0.0","version":null,"received":0,"total":null,"error":null,"checked_at":null}` {
		t.Fatal(string(encoded))
	}
	// No previously available release means failure phase; checked_at stays unset.
	m = New(Options{Version: "1.0.0"})
	m.client = doerFunc(func(r *http.Request) (*http.Response, error) { return nil, errors.New("offline") })
	if m.Check(context.Background()) == nil || m.View().Phase != "failed" || m.View().CheckedAt != nil {
		t.Fatal(m.View())
	}
}

func TestManifestAndDownloadLimitsAndErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	canceled := New(Options{Version: "1.0.0"})
	canceled.client = doerFunc(func(r *http.Request) (*http.Response, error) { return response(r, []byte(`{"version":"1.0.0"}`)), nil })
	if err := canceled.Check(ctx); !errors.Is(err, context.Canceled) || canceled.View().CheckedAt != nil {
		t.Fatal("canceled check published success", err)
	}
	public, _, key := syntheticKey(t)
	sig := signedBytes(t, key, []byte("x"))
	for _, data := range [][]byte{[]byte("{"), []byte(strings.Repeat("x", maxManifest+1)), feedJSON("not-semver", "darwin-aarch64", sig), feedJSON("2.0.0", "other", sig), feedJSON("2.0.0", "darwin-aarch64", "garbage")} {
		m := New(Options{Version: "1.0.0", PublicKey: public, Platform: "darwin-aarch64"})
		m.client = doerFunc(func(r *http.Request) (*http.Response, error) { return response(r, data), nil })
		if err := m.Check(context.Background()); err == nil {
			t.Fatal("accepted bad manifest")
		}
	}
	for _, scenario := range []string{"http error", "oversized", "empty", "truncated", "encoding"} {
		t.Run(scenario, func(t *testing.T) {
			m := New(Options{Version: "1.0.0", Platform: "darwin-aarch64"})
			m.client = doerFunc(func(r *http.Request) (*http.Response, error) {
				res := response(r, []byte("x"))
				switch scenario {
				case "http error":
					res.StatusCode = 500
				case "oversized":
					res.ContentLength = maxArtifact + 1
				case "empty":
					res.ContentLength = 0
					res.Body = io.NopCloser(strings.NewReader(""))
				case "truncated":
					res.ContentLength = 10
				case "encoding":
					res.Header.Set("Content-Encoding", "gzip")
				}
				return res, nil
			})
			if _, err := m.download(context.Background(), release{URL: "https://github.com/artifact"}); err == nil {
				t.Fatal("accepted invalid artifact")
			}
		})
	}
}

// Valid minimal PE32 metadata models the NSIS loader; it contains no executable
// code and the test always injects launch, so this can never install anything.
func fakeNSIS(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	dos := make([]byte, 128)
	copy(dos, "MZ")
	binary.LittleEndian.PutUint32(dos[0x3c:], 128)
	buffer.Write(dos)
	buffer.WriteString("PE\x00\x00")
	header := pe.FileHeader{Machine: pe.IMAGE_FILE_MACHINE_I386, SizeOfOptionalHeader: 224, Characteristics: pe.IMAGE_FILE_EXECUTABLE_IMAGE}
	if err := binary.Write(&buffer, binary.LittleEndian, header); err != nil {
		t.Fatal(err)
	}
	if err := binary.Write(&buffer, binary.LittleEndian, pe.OptionalHeader32{Magic: 0x10b, NumberOfRvaAndSizes: 16}); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestVerifiedWindowsHandoffAndErrors(t *testing.T) {
	for _, scenario := range []string{"success", "bad signature", "not PE", "prepare failed", "launch failed", "exit failed", "canceled"} {
		t.Run(scenario, func(t *testing.T) {
			public, _, key := syntheticKey(t)
			artifact := fakeNSIS(t)
			if scenario == "not PE" {
				artifact = []byte("fake")
			}
			signature := signedBytes(t, key, artifact)
			if scenario == "bad signature" {
				signature = signedBytes(t, key, []byte("different"))
			}
			calls := []string{}
			var retained string
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			m := New(Options{Version: "1.0.0", PublicKey: public, Platform: "windows-x86_64-nsis", BeforeInstall: func(context.Context) error {
				calls = append(calls, "before")
				if scenario == "prepare failed" {
					return errors.New("stop failed")
				}
				return nil
			}, AfterInstall: func() error {
				calls = append(calls, "after")
				if scenario == "exit failed" {
					return errors.New("exit failed")
				}
				return nil
			}})
			m.pending = &release{Version: "2.0.0", URL: "https://github.com/artifact", Signature: signature}
			m.client = doerFunc(func(r *http.Request) (*http.Response, error) {
				deadline, ok := r.Context().Deadline()
				if !ok || time.Until(deadline) > downloadTimeout {
					t.Fatal("unbounded download")
				}
				if scenario == "canceled" {
					cancel()
				}
				return response(r, artifact), nil
			})
			m.launch = func(path string, args []string) error {
				calls = append(calls, "launch")
				retained = path
				if !reflect.DeepEqual(args, []string{"/UPDATE", "/R"}) {
					t.Fatal(args)
				}
				data, _ := os.ReadFile(path)
				if !bytes.Equal(data, artifact) {
					t.Fatal("installer bytes changed")
				}
				if scenario == "launch failed" {
					return errors.New("launch failed")
				}
				return nil
			}
			err := m.Install(ctx)
			if (err == nil) != (scenario == "success") {
				t.Fatal(err)
			}
			if scenario == "bad signature" || scenario == "not PE" || scenario == "canceled" {
				if len(calls) != 0 {
					t.Fatal("unverified input reached hook", calls)
				}
			}
			if scenario == "success" || scenario == "exit failed" {
				if !reflect.DeepEqual(calls, []string{"before", "launch", "after"}) {
					t.Fatal(calls)
				}
				if _, err := os.Stat(retained); err != nil {
					t.Fatal("NSIS artifact deleted before handoff", err)
				}
				_ = os.RemoveAll(filepath.Dir(retained))
			} else if retained != "" {
				if _, err := os.Stat(retained); !os.IsNotExist(err) {
					t.Fatal("failed launch leaked artifact", err)
				}
			}
			if scenario == "success" {
				if m.View().Phase != "restarting" {
					t.Fatal(m.View())
				}
			} else if m.View().Phase != "available" || m.View().Error == nil {
				t.Fatal(m.View())
			}
		})
	}
}

func TestProgressConcurrencyAndRunCancellation(t *testing.T) {
	public, _, key := syntheticKey(t)
	data := bytes.Repeat([]byte("x"), 3<<20)
	m := New(Options{Version: "1.0.0", PublicKey: public, Platform: "windows-x86_64-nsis"})
	m.pending = &release{Version: "2.0.0", URL: "https://github.com/artifact", Signature: signedBytes(t, key, data)}
	started := make(chan struct{})
	releaseRequest := make(chan struct{})
	var once sync.Once
	m.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		once.Do(func() { close(started) })
		<-releaseRequest
		return response(r, data), nil
	})
	var views []View
	m.SetListener(func(v View) { views = append(views, v) })
	finished := make(chan error, 1)
	go func() { finished <- m.Install(context.Background()) }()
	<-started
	if err := m.Check(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
	if err := m.Install(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
	close(releaseRequest)
	if err := <-finished; err == nil {
		t.Fatal("fake non-PE unexpectedly installed")
	}
	count := 0
	var received uint64
	for _, v := range views {
		if v.Phase == "downloading" {
			count++
			if v.Received < received {
				t.Fatal("progress reversed")
			}
			received = v.Received
		}
	}
	if count > 102 || received != uint64(len(data)) {
		t.Fatal(count, received)
	}
	if progressStep(300, ptr(uint64(200))) != 100 || progressStep(3<<20, nil) != 3 {
		t.Fatal("invalid progress steps")
	}
	// Unknown sizes produce one publication per MiB, rather than per read.
	m = New(Options{Version: "1.0.0"})
	m.client = doerFunc(func(r *http.Request) (*http.Response, error) {
		res := response(r, data)
		res.ContentLength = -1
		return res, nil
	})
	count = 0
	m.SetListener(func(v View) {
		if v.Phase == "downloading" {
			count++
		}
	})
	downloaded, err := m.download(context.Background(), release{URL: "https://github.com/artifact"})
	if err != nil {
		t.Fatal(err)
	}
	_ = os.RemoveAll(downloaded.directory)
	if count > 4 {
		t.Fatal("unthrottled unknown-size progress", count)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler ignored cancellation")
	}
	if err := New(Options{}).Install(context.Background()); !errors.Is(err, ErrNoUpdate) {
		t.Fatal(err)
	}
}
func ptr[T any](v T) *T { return &v }

func TestWallClockSchedule(t *testing.T) {
	now := time.Unix(1000000000, 0)
	for _, pair := range [][2]time.Duration{{firstCheck, firstJitter}, {checkInterval, checkJitter}, {retryInterval, retryJitter}} {
		width := uint64(2*pair[1]/time.Millisecond + 1)
		for _, sample := range []uint64{0, width - 1, width, ^uint64(0)} {
			s := newSchedule(now, pair[0], pair[1], sample)
			if s.delay < pair[0]-pair[1] || s.delay > pair[0]+pair[1] {
				t.Fatal(s)
			}
			if s.remaining(now.Add(s.delay)) != 0 {
				t.Fatal("not due after sleep")
			}
			earlier := now.Add(-24 * time.Hour)
			if s.remaining(earlier) != s.delay || s.remaining(earlier.Add(s.delay)) != 0 {
				t.Fatal("backwards clock not rebased")
			}
		}
	}
	failed := afterCheck(now, false, 0)
	success := afterCheck(now, true, 0)
	if failed.delay != retryInterval-retryJitter || success.delay != checkInterval-checkJitter {
		t.Fatal(failed, success)
	}
}
