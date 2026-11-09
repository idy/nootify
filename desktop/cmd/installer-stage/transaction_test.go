package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fakeService struct {
	active    bool
	calls     []string
	failStart int
	failStop  bool
}

func (s *fakeService) running() (bool, error) {
	s.calls = append(s.calls, "status")
	return s.active, nil
}
func (s *fakeService) stop() error {
	s.calls = append(s.calls, "stop")
	s.active = false
	if s.failStop {
		return errors.New("stop failed")
	}
	return nil
}
func (s *fakeService) start() error {
	s.calls = append(s.calls, "start")
	if s.failStart > 0 {
		s.failStart--
		return errors.New("start failed")
	}
	s.active = true
	return nil
}

func put(t *testing.T, path, value string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func payload(t *testing.T, root, version string) {
	t.Helper()
	for _, name := range []string{"Nootify.exe", "node.exe", "nootify-core.exe", "nootify-tsnet.exe", "service/dist/src/cli.js", "service/dist/src/server.js", "service/windows/service.ps1", "uninstall.exe"} {
		put(t, filepath.Join(root, filepath.FromSlash(name)), version+":"+name)
	}
}

func tree(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || strings.Contains(path, transactionName+string(filepath.Separator)) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		result[relative] = string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func fixture(t *testing.T, running bool) (transaction, *fakeService, string, map[string]string) {
	t.Helper()
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(work, "Nootify installation with spaces")
	payload(t, target, "old")
	put(t, filepath.Join(target, "state", "private-marker"), "private state retained")
	put(t, filepath.Join(target, "unrelated.txt"), "unrelated file retained")
	before := tree(t, target)
	service := &fakeService{active: running}
	tx := transaction{target: target, service: service}
	if err := tx.prepare(); err != nil {
		t.Fatal(err)
	}
	payload(t, tx.dir("new"), "new")
	manifest := map[string]string{}
	err = filepath.WalkDir(tx.dir("new"), func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		relative, _ := filepath.Rel(tx.dir("new"), path)
		if relative == "uninstall.exe" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(data)
		manifest[filepath.ToSlash(relative)] = hex.EncodeToString(digest[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(manifest)
	manifestPath := filepath.Join(work, "trusted-manifest.json")
	put(t, manifestPath, string(data))
	return tx, service, manifestPath, before
}

func TestUpgradeRestoresPriorServiceWithoutDesktop(t *testing.T) {
	for _, running := range []bool{true, false} {
		t.Run(map[bool]string{true: "running", false: "deliberately-stopped"}[running], func(t *testing.T) {
			tx, service, manifest, _ := fixture(t, running)
			if err := tx.apply(manifest); err != nil {
				t.Fatal(err)
			}
			if err := tx.finish(); err != nil {
				t.Fatal(err)
			}
			if service.active != running {
				t.Fatalf("service active=%v, previously=%v", service.active, running)
			}
			want := []string{"status", "stop"}
			if running {
				want = append(want, "start")
			}
			if !reflect.DeepEqual(service.calls, want) {
				t.Fatal(service.calls)
			}
			if exists(tx.dir()) {
				t.Fatal("committed transaction was not cleaned")
			}
			files := tree(t, tx.target)
			if files["Nootify.exe"] != "new:Nootify.exe" || files[filepath.Join("state", "private-marker")] != "private state retained" || files["unrelated.txt"] != "unrelated file retained" {
				t.Fatal(files)
			}
		})
	}
}

func TestEveryExchangeFailureAndInterruptionRestoresOldPayload(t *testing.T) {
	points := []string{"before-stop", "after-stop", "ready"}
	for _, root := range payloadRoots {
		points = append(points, "backup:"+root, "install:"+root)
	}
	for _, point := range points {
		for _, crash := range []bool{false, true} {
			t.Run(point+map[bool]string{true: "/interrupted", false: "/error"}[crash], func(t *testing.T) {
				tx, service, manifest, before := fixture(t, true)
				tx.checkpoint = func(name string) error {
					if name == point {
						if crash {
							panic("simulated interruption")
						}
						return errors.New("simulated exchange error")
					}
					return nil
				}
				if crash {
					func() {
						defer func() {
							if recover() == nil {
								t.Fatal("missing interruption")
							}
						}()
						_ = tx.apply(manifest)
					}()
					tx.checkpoint = nil
					if err := tx.recover(); err != nil {
						t.Fatal(err)
					}
				} else if err := tx.apply(manifest); err == nil {
					t.Fatal("missing exchange failure")
				}
				if !reflect.DeepEqual(tree(t, tx.target), before) {
					t.Fatal("old payload or private data was changed")
				}
				if !service.active {
					t.Fatal("previously running service was not restored")
				}
				if exists(tx.dir()) {
					t.Fatal("rollback not cleaned")
				}
			})
		}
	}
}

func TestValidationAndExtractionErrorsLeaveServiceAndOldPayloadUntouched(t *testing.T) {
	for _, damage := range []string{"corrupt", "missing", "extra", "partial-extraction"} {
		t.Run(damage, func(t *testing.T) {
			tx, service, manifest, before := fixture(t, true)
			switch damage {
			case "corrupt":
				put(t, tx.dir("new", "node.exe"), "truncated")
			case "missing":
				if err := os.Remove(tx.dir("new", "service", "dist", "src", "server.js")); err != nil {
					t.Fatal(err)
				}
			case "extra":
				put(t, tx.dir("new", "unexpected.txt"), "extra")
			case "partial-extraction":
				if err := os.RemoveAll(tx.dir("new", "service")); err != nil {
					t.Fatal(err)
				}
			}
			if err := tx.apply(manifest); err == nil {
				t.Fatal("invalid extraction accepted")
			}
			if len(service.calls) != 0 || !service.active {
				t.Fatal(service.calls)
			}
			if err := tx.recover(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) {
				t.Fatal("old payload changed")
			}
		})
	}
}

func TestStopAndRestartFailureRollBackAndRestoreService(t *testing.T) {
	for _, stopFailure := range []bool{true, false} {
		t.Run(map[bool]string{true: "stop", false: "restart"}[stopFailure], func(t *testing.T) {
			tx, service, manifest, before := fixture(t, true)
			service.failStop = stopFailure
			if !stopFailure {
				service.failStart = 1
			}
			if err := tx.apply(manifest); err == nil {
				t.Fatal("missing service failure")
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) || !service.active {
				t.Fatal("rollback did not restore prior payload/service")
			}
		})
	}
}

func TestRollbackStartFailureRetainsJournalForRetry(t *testing.T) {
	tx, service, manifest, before := fixture(t, true)
	service.failStart = 2 // New service Start and first rollback Start both fail.
	if err := tx.apply(manifest); err == nil {
		t.Fatal("missing restart failure")
	}
	if !exists(tx.dir("journal.json")) {
		t.Fatal("missing recoverable journal")
	}
	if err := tx.recover(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tree(t, tx.target), before) || !service.active {
		t.Fatal("retry did not preserve restored old payload")
	}
}

func TestUntrustedJournalAndReparsePathsRefused(t *testing.T) {
	tx, service, _, before := fixture(t, true)
	j := journal{Version: 1, Target: tx.target, Phase: "exchanging", Previous: []string{"../unrelated"}, Running: true}
	if err := tx.write(j); err != nil {
		t.Fatal(err)
	}
	if err := tx.recover(); err == nil {
		t.Fatal("accepted journal authorizing an unowned path")
	}
	if len(service.calls) != 0 || !reflect.DeepEqual(tree(t, tx.target), before) {
		t.Fatal("untrusted journal changed files/service")
	}
	other := t.TempDir()
	redirect := filepath.Join(t.TempDir(), "redirect")
	if err := os.Symlink(other, redirect); err != nil {
		t.Skip("symlink creation unavailable")
	}
	if err := (transaction{target: redirect}).prepare(); err == nil {
		t.Fatal("accepted redirected install target")
	}
	if err := os.Symlink(other, tx.dir("new", "redirect")); err != nil {
		t.Fatal(err)
	}
	if err := tx.recover(); err == nil {
		t.Fatal("accepted reparse entry inside transaction")
	}
}

func TestCommittedInterruptionKeepsNewPayload(t *testing.T) {
	tx, service, manifest, _ := fixture(t, true)
	if err := tx.apply(manifest); err != nil {
		t.Fatal(err)
	}
	j, err := tx.read()
	if err != nil {
		t.Fatal(err)
	}
	j.Phase = "committed"
	if err := tx.write(j); err != nil {
		t.Fatal(err)
	}
	calls := len(service.calls)
	if err := tx.recover(); err != nil {
		t.Fatal(err)
	}
	if tree(t, tx.target)["Nootify.exe"] != "new:Nootify.exe" || len(service.calls) != calls {
		t.Fatal("committed package was rolled back")
	}
}

func TestInterruptedRollbackResumesWithoutInvokingHalfRestoredCLI(t *testing.T) {
	for _, root := range payloadRoots {
		for _, operation := range []string{"discard:", "restore:"} {
			t.Run(operation+root, func(t *testing.T) {
				tx, service, manifest, before := fixture(t, true)
				tx.checkpoint = func(name string) error {
					if name == "ready" {
						panic("interrupted upgrade")
					}
					return nil
				}
				func() { defer func() { _ = recover() }(); _ = tx.apply(manifest) }()
				tx.checkpoint = func(name string) error {
					if name == operation+root {
						panic("interrupted rollback")
					}
					return nil
				}
				func() {
					defer func() {
						if recover() == nil {
							t.Fatal("missing rollback interruption")
						}
					}()
					_ = tx.recover()
				}()
				calls := len(service.calls)
				tx.checkpoint = nil
				if err := tx.recover(); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(tree(t, tx.target), before) || !service.active {
					t.Fatal("interrupted rollback lost old payload/service")
				}
				if !reflect.DeepEqual(service.calls[calls:], []string{"start"}) {
					t.Fatal("retry invoked the half-restored CLI before restoring files", service.calls[calls:])
				}
			})
		}
	}
}

func TestStoppedServiceFailureNeverStartsIt(t *testing.T) {
	tx, service, manifest, before := fixture(t, false)
	tx.checkpoint = func(name string) error {
		if name == "install:node.exe" {
			return errors.New("exchange failed")
		}
		return nil
	}
	if err := tx.apply(manifest); err == nil {
		t.Fatal("missing exchange failure")
	}
	if service.active || contains(service.calls, "start") || !reflect.DeepEqual(tree(t, tx.target), before) {
		t.Fatal("rollback did not preserve a deliberately stopped service")
	}
}

func TestFreshPayloadRootIsRemovedOnRollback(t *testing.T) {
	tx, service, manifest, _ := fixture(t, false)
	if err := os.Remove(filepath.Join(tx.target, "nootify-core.exe")); err != nil {
		t.Fatal(err)
	}
	before := tree(t, tx.target)
	tx.checkpoint = func(name string) error {
		if name == "ready" {
			return errors.New("registration failed")
		}
		return nil
	}
	if err := tx.apply(manifest); err == nil {
		t.Fatal("missing failure")
	}
	if !reflect.DeepEqual(tree(t, tx.target), before) || service.active {
		t.Fatal("rollback retained a newly added root or started the stopped service")
	}
}

func TestEmptyInterruptedTransactionDirectoryCanBeRecovered(t *testing.T) {
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tx := transaction{target: work}
	if err := os.Mkdir(tx.dir(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := tx.recover(); err != nil {
		t.Fatal(err)
	}
	if exists(tx.dir()) {
		t.Fatal("empty interrupted transaction was not removed")
	}
}

func TestInstallerChildEnvironmentStripsInjectionAndAccountValues(t *testing.T) {
	for _, name := range []string{"NODE_OPTIONS", "NODE_PATH", "LARK_APP_SECRET", "TAILSCALE_AUTHKEY", "NOOTIFY_CORE_BIN"} {
		t.Setenv(name, "must-not-inherit")
	}
	for _, value := range installerEnvironment() {
		if strings.Contains(value, "must-not-inherit") {
			t.Fatal("unsafe inherited environment")
		}
	}
}
