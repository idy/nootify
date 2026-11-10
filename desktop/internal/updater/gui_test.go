package updater

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// Every launch in these tests is a synthetic test-binary child. No MyGo/native
// initialization, Launch Services, installed service manager or real update runs.
func TestGUIHandoffChild(t *testing.T) {
	mode := os.Getenv("NOOTIFY_GUI_CHILD")
	if mode == "" {
		return
	}
	path := os.Getenv("NOOTIFY_GUI_RECEIPT")
	exe := os.Getenv("NOOTIFY_GUI_EXE")
	version := os.Getenv("NOOTIFY_GUI_VERSION")
	client, err := acceptGUIHandoff(path, exe, version, "dev.idy.nootify")
	if err != nil {
		os.Exit(21)
	}
	if mode == "crash" {
		os.Exit(22)
	}
	if mode == "conflict" {
		client.Refuse()
		client.Stopped()
		os.Exit(0)
	}
	if mode == "hang" {
		select {}
	}
	if mode == "reject-commit" {
		_ = client.writer.Encode(guiMessage{Action: "ready"})
		var message guiMessage
		if client.reader.Decode(&message) != nil || message.Action != "commit" {
			os.Exit(23)
		}
		_ = client.writer.Encode(guiMessage{Action: "not-committed"})
		if client.reader.Decode(&message) != nil || message.Action != "abort" {
			os.Exit(24)
		}
		client.Stopped()
		os.Exit(0)
	}
	ready := make(chan struct{})
	if mode != "not-ready" {
		close(ready)
	}
	committed := false
	client.AwaitCommit(ready, func() { committed = true }, func() {})
	if committed {
		body, _ := json.Marshal(map[string]any{"suppress_service_start": client.SuppressServiceStart(), "version": version})
		_ = os.WriteFile(os.Getenv("NOOTIFY_GUI_RESULT"), body, 0600)
	}
	client.Stopped()
	os.Exit(0)
}

func fakeGUIUpdate(t *testing.T) *Manager {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("macOS bundle directory/symlink semantics")
	}
	exe := installedFakeApp(t)
	m := New(Options{Executable: exe, Version: "1.0.0", ConfirmGUI: true})
	m.pending = &release{Version: "2.0.0"}
	m.swap = testSwap // private fixture directories on every OS, never native exchange
	if err := m.installMac(context.Background(), appArchive(t, bundleEntries())); err != nil {
		t.Fatal(err)
	}
	if !m.PendingGUI() {
		t.Fatal("installation discarded the GUI transaction")
	}
	data, err := os.ReadFile(filepath.Join(m.guiPending.replacement, "Contents", "MacOS", "Nootify"))
	if err != nil || string(data) != "original" {
		t.Fatal("original deleted before GUI launch", err)
	}
	return m
}

func childLauncher(t *testing.T, m *Manager, firstMode string) (func(context.Context, string, []string) error, *int, string) {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	result := filepath.Join(t.TempDir(), "gui-result.json")
	var mu sync.Mutex
	var children []*exec.Cmd
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for _, child := range children {
			if child.ProcessState == nil {
				_ = child.Process.Kill()
			}
			_ = child.Wait()
		}
	})
	launch := func(_ context.Context, executable string, args []string) error {
		calls++
		if len(args) != 2 || args[0] != GUIHandoffFlag {
			t.Fatal(args)
		}
		if calls == 1 && firstMode == "exec-failure" {
			// A real OS spawn failure, not a fake successful service-start callback.
			return exec.Command(filepath.Join(t.TempDir(), "missing-GUI-executable")).Start()
		}
		mode := "ready"
		version := "1.0.0"
		if calls == 1 {
			mode = firstMode
			version = "2.0.0"
		}
		cmd := exec.Command(binary, "-test.run=^TestGUIHandoffChild$")
		cmd.Env = append(os.Environ(), "NOOTIFY_GUI_CHILD="+mode, "NOOTIFY_GUI_RECEIPT="+args[1], "NOOTIFY_GUI_EXE="+executable, "NOOTIFY_GUI_VERSION="+version, "NOOTIFY_GUI_RESULT="+result)
		if err := cmd.Start(); err != nil {
			return err
		}
		mu.Lock()
		children = append(children, cmd)
		mu.Unlock()
		return nil
	}
	return launch, &calls, result
}

func TestMacGUIConfirmationPreservesPriorServiceStateAndBackup(t *testing.T) {
	for _, stopped := range []bool{false, true} {
		t.Run(map[bool]string{false: "running", true: "deliberately stopped"}[stopped], func(t *testing.T) {
			m := fakeGUIUpdate(t)
			stage := m.guiPending.staging
			launch, calls, result := childLauncher(t, m, "ready")
			starts := 0
			err := m.FinishGUI(context.Background(), GUIRelaunchOptions{SuppressServiceStart: stopped, Launch: launch, StartupTimeout: 2 * time.Second, ShutdownTimeout: time.Second, AfterReady: func() error {
				// Service recovery success must not have removed the original before
				// the separate GUI commit. Its native replacement is now ready.
				if _, err := os.Stat(filepath.Join(stage, "Nootify.app", "Contents", "MacOS", "Nootify")); err != nil {
					t.Fatal("backup gone before GUI commit", err)
				}
				if !stopped {
					starts++
				}
				return nil
			}})
			if err != nil || *calls != 1 {
				t.Fatal(err, *calls)
			}
			if _, err := os.Stat(stage); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("confirmed backup not cleaned", err)
			}
			var state struct {
				Suppress bool   `json:"suppress_service_start"`
				Version  string `json:"version"`
			}
			deadline := time.Now().Add(time.Second)
			for {
				data, err := os.ReadFile(result)
				if err == nil {
					if json.Unmarshal(data, &state) != nil {
						t.Fatal(string(data))
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal(err)
				}
				time.Sleep(time.Millisecond)
			}
			if state.Suppress != stopped || state.Version != "2.0.0" || starts != map[bool]int{true: 0, false: 1}[stopped] {
				t.Fatal("relaunch lost prior stopped policy", state, starts)
			}
		})
	}
}

func TestRealGUILaunchFailureRollsBackAndReopensOriginalWithStoppedPolicy(t *testing.T) {
	for _, mode := range []string{"exec-failure", "not-ready"} {
		t.Run(mode, func(t *testing.T) {
			m := fakeGUIUpdate(t)
			stage := m.guiPending.staging
			launch, calls, result := childLauncher(t, m, mode)
			recovered := 0
			err := m.FinishGUI(context.Background(), GUIRelaunchOptions{SuppressServiceStart: true, Launch: launch, StartupTimeout: 100 * time.Millisecond, ShutdownTimeout: time.Second, RecoverOriginal: func() error { recovered++; return nil }})
			if err == nil || !strings.Contains(err.Error(), "original restored and GUI reopened") || *calls != 2 || recovered != 1 {
				t.Fatal(err, *calls, recovered)
			}
			data, err := os.ReadFile(m.options.Executable)
			if err != nil || string(data) != "original" {
				t.Fatal("failed GUI replaced original", string(data), err)
			}
			if _, err := os.Stat(stage); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("recovered transaction retained staging", err)
			}
			deadline := time.Now().Add(time.Second)
			for {
				data, err = os.ReadFile(result)
				if err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal(err)
				}
				time.Sleep(time.Millisecond)
			}
			if !strings.Contains(string(data), `"suppress_service_start":true`) || !strings.Contains(string(data), `"version":"1.0.0"`) {
				t.Fatal("rollback GUI lost original stopped state", string(data))
			}
		})
	}
}

func TestUnconfirmedOrUnquiescedGUIRetainsBothBundles(t *testing.T) {
	for _, mode := range []string{"crash", "conflict"} {
		t.Run(mode, func(t *testing.T) {
			m := fakeGUIUpdate(t)
			p := m.guiPending
			launch, calls, _ := childLauncher(t, m, mode)
			err := m.FinishGUI(context.Background(), GUIRelaunchOptions{Launch: launch, StartupTimeout: 200 * time.Millisecond, ShutdownTimeout: 100 * time.Millisecond})
			if err == nil || *calls != 1 || !m.PendingGUI() || !strings.Contains(err.Error(), "original retained") {
				t.Fatal(err, *calls)
			}
			if !p.valid() {
				t.Fatal("unconfirmed GUI resources exchanged/deleted")
			}
		})
	}
}

func TestGUIServiceStartFailureQuiescesBeforeRollback(t *testing.T) {
	m := fakeGUIUpdate(t)
	launch, calls, _ := childLauncher(t, m, "ready")
	started := false
	stopped := false
	m.options.BeforeRollback = func() error {
		if !started {
			t.Fatal("rollback ran before partial service bootstrap")
		}
		stopped = true
		return nil
	}
	previousSwap := m.swap
	m.swap = func(a, b string) error {
		if !stopped {
			t.Fatal("rollback moved a live replacement's resources")
		}
		return previousSwap(a, b)
	}
	err := m.FinishGUI(context.Background(), GUIRelaunchOptions{Launch: launch, StartupTimeout: time.Second, ShutdownTimeout: time.Second, AfterReady: func() error { started = true; return errors.New("partial bootstrap") }})
	if err == nil || !stopped || *calls != 2 {
		t.Fatal(err, stopped, *calls)
	}
}

func TestGUICommitFailureStopsStartedReplacementBeforeRollback(t *testing.T) {
	m := fakeGUIUpdate(t)
	launch, calls, _ := childLauncher(t, m, "reject-commit")
	started, quiesced, recovered := false, false, false
	m.options.BeforeRollback = func() error {
		if !started {
			t.Fatal("service was not started before failed commit")
		}
		quiesced = true
		return nil
	}
	previousSwap := m.swap
	m.swap = func(a, b string) error {
		if !quiesced {
			t.Fatal("commit failure exchanged a running service's resources")
		}
		return previousSwap(a, b)
	}
	err := m.FinishGUI(context.Background(), GUIRelaunchOptions{Launch: launch, StartupTimeout: time.Second, ShutdownTimeout: time.Second,
		AfterReady: func() error { started = true; return nil }, RecoverOriginal: func() error { recovered = true; return nil }})
	if err == nil || !strings.Contains(err.Error(), "did not confirm commit") || !quiesced || !recovered || *calls != 2 {
		t.Fatal(err, quiesced, recovered, *calls)
	}
}

func TestFailedServiceQuiescenceRetainsOriginalAfterGUIAbort(t *testing.T) {
	m := fakeGUIUpdate(t)
	p := m.guiPending
	launch, calls, _ := childLauncher(t, m, "reject-commit")
	m.options.BeforeRollback = func() error { return errors.New("replacement service still draining") }
	err := m.FinishGUI(context.Background(), GUIRelaunchOptions{Launch: launch, StartupTimeout: time.Second, ShutdownTimeout: time.Second})
	if err == nil || !strings.Contains(err.Error(), "service could not be quiesced") || *calls != 1 || !p.valid() {
		t.Fatal("unsafe rollback after quiescence failure", err, *calls)
	}
}

func TestCancelledPendingGUIRestoresOriginalBeforeAnyLaunch(t *testing.T) {
	m := fakeGUIUpdate(t)
	stage := m.guiPending.staging
	if err := m.AbortGUI(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(m.options.Executable)
	if err != nil || string(data) != "original" || m.PendingGUI() {
		t.Fatal("cancelled GUI transaction not rolled back", err)
	}
	if _, err := os.Stat(stage); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled GUI transaction left staging", err)
	}
}

func TestGUIReceiptRequiresVersionIdentityExecutableAndLiveOneUseSupervisor(t *testing.T) {
	exe := installedFakeApp(t)
	options := GUIRelaunchOptions{StartupTimeout: time.Second, ShutdownTimeout: time.Second}
	_, path, listener, err := writeReceipt(t.TempDir(), exe, "2.0.0", options)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	defer listener.Close()
	for _, value := range []struct{ version, identity string }{{"1.0.0", "dev.idy.nootify"}, {"2.0.0", "dev.idy.nootify.dev"}} {
		if c, err := acceptGUIHandoff(path, exe, value.version, value.identity); err == nil {
			c.Stopped()
			t.Fatal("wrong executable identity accepted")
		}
	}
	if err := os.WriteFile(exe, []byte("different-executable"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := acceptGUIHandoff(path, exe, "2.0.0", "dev.idy.nootify"); err == nil {
		t.Fatal("changed executable accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := acceptGUIHandoff(path, exe, "2.0.0", "dev.idy.nootify"); err == nil {
		t.Fatal("consumed receipt accepted")
	}
}
