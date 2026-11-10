package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestUpgradeAndRollbackPreserveEnabledSeparatelyFromRunning(t *testing.T) {
	for _, active := range []bool{false, true} {
		for _, enabled := range []bool{false, true} {
			for _, fail := range []bool{false, true} {
				t.Run(map[bool]string{false: "idle", true: "running"}[active]+map[bool]string{false: "/disabled", true: "/enabled"}[enabled]+map[bool]string{false: "/commit", true: "/rollback"}[fail], func(t *testing.T) {
					tx, service, manifest, before := fixture(t, active)
					service.enabled = enabled
					if fail {
						tx.checkpoint = func(name string) error {
							if name == "install:node.exe" {
								return errors.New("exchange failure")
							}
							return nil
						}
					}
					err := tx.apply(manifest)
					if (err != nil) != fail {
						t.Fatal(err)
					}
					if !fail {
						if err := tx.finish(); err != nil {
							t.Fatal(err)
						}
					}
					if service.active != active || service.enabled != enabled {
						t.Fatalf("prior state not preserved: running=%v enabled=%v", service.active, service.enabled)
					}
					if !active && contains(service.calls, "start") {
						t.Fatal("idle task was started")
					}
					if fail && !reflect.DeepEqual(tree(t, tx.target), before) {
						t.Fatal("rollback changed old payload")
					}
				})
			}
		}
	}
}

func TestInitialJournalWriteFailuresCanBeRetriedSafely(t *testing.T) {
	for _, point := range []string{"journal-next-open", "journal-next-write", "journal-next-sync"} {
		t.Run(point, func(t *testing.T) {
			root, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			tx := transaction{target: root, checkpoint: func(name string) error {
				if name == point {
					return errors.New("initial write failed")
				}
				return nil
			}}
			put(t, filepath.Join(root, "unrelated.txt"), "keep")
			if err := tx.prepare(); err == nil {
				t.Fatal("missing initial journal failure")
			}
			if !exists(tx.dir("journal.next")) || exists(tx.dir("journal.json")) {
				t.Fatal("failure did not reproduce pre-journal state")
			}
			tx.checkpoint = nil
			if err := tx.prepare(); err != nil {
				t.Fatal(err)
			}
			if err := tx.recover(); err != nil {
				t.Fatal(err)
			}
			if tree(t, root)["unrelated.txt"] != "keep" {
				t.Fatal("pre-journal recovery changed another file")
			}
		})
	}
}

func TestPreJournalRecoveryRefusesUnexpectedOrRedirectedEntries(t *testing.T) {
	for _, unexpected := range []string{"old/node.exe", "new/service/foreign.txt", "unrelated.txt"} {
		t.Run(unexpected, func(t *testing.T) {
			root, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			tx := transaction{target: root}
			put(t, tx.dir("journal.next"), "partial")
			put(t, tx.dir(filepath.FromSlash(unexpected)), "keep")
			if err := tx.recover(); err == nil {
				t.Fatal("unpublished journal authorized extra data deletion")
			}
			if !exists(tx.dir("journal.next")) || !exists(tx.dir(filepath.FromSlash(unexpected))) {
				t.Fatal("unexpected entries changed")
			}
		})
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tx := transaction{target: root}
	if err := os.Mkdir(tx.dir(), 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside")
	put(t, outside, "keep")
	if err := os.Symlink(outside, tx.dir("journal.next")); err != nil {
		t.Skip("symlink creation unavailable")
	}
	if err := tx.recover(); err == nil {
		t.Fatal("redirected initial journal accepted")
	}
	if tree(t, root)["outside"] != "keep" {
		t.Fatal("outside data changed")
	}
}

func TestInterruptedFreshInstallRequiresExternalReceiptAndNoPriorPayload(t *testing.T) {
	for _, point := range []string{"staging", "install:Nootify.exe", "install:service", "ready"} {
		t.Run(point, func(t *testing.T) {
			tx, service, manifest, _ := fixture(t, false)
			for _, root := range payloadRoots {
				if err := os.RemoveAll(filepath.Join(tx.target, root)); err != nil {
					t.Fatal(err)
				}
			}
			j, err := tx.read()
			if err != nil {
				t.Fatal(err)
			}
			tx.freshToken = "synthetic-pending-receipt"
			j.FreshToken = tx.freshToken
			if err := tx.write(j); err != nil {
				t.Fatal(err)
			}
			before := tree(t, tx.target)
			if point != "staging" {
				tx.checkpoint = func(name string) error {
					if name == point {
						panic("interrupted fresh install")
					}
					return nil
				}
				func() {
					defer func() {
						if recover() == nil {
							t.Fatal("missing interruption")
						}
					}()
					_ = tx.apply(manifest)
				}()
			}
			unauthorized := tx
			unauthorized.freshToken = ""
			unauthorized.checkpoint = nil
			if err := unauthorized.recover(); err == nil {
				t.Fatal("unregistered journal alone authorized recovery")
			}
			wrong := unauthorized
			wrong.freshToken = "different-receipt"
			if err := wrong.recover(); err == nil {
				t.Fatal("wrong receipt authorized recovery")
			}
			tx.checkpoint = nil
			if err := tx.prepare(); err != nil {
				t.Fatal(err)
			}
			if err := tx.recover(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) || service.active || service.enabled {
				t.Fatal("fresh recovery touched unrelated files or started service")
			}
		})
	}
}

func TestFreshCommitAfterRegistrationCanBeFinalizedIdempotently(t *testing.T) {
	for _, phase := range []string{"ready", "committed"} {
		t.Run(phase, func(t *testing.T) {
			tx, _, manifest, _ := fixture(t, false)
			for _, root := range payloadRoots {
				if err := os.RemoveAll(filepath.Join(tx.target, root)); err != nil {
					t.Fatal(err)
				}
			}
			j, err := tx.read()
			if err != nil {
				t.Fatal(err)
			}
			tx.freshToken = "pending-receipt"
			j.FreshToken = tx.freshToken
			if err := tx.write(j); err != nil {
				t.Fatal(err)
			}
			if err := tx.apply(manifest); err != nil {
				t.Fatal(err)
			}
			j, err = tx.read()
			if err != nil {
				t.Fatal(err)
			}
			j.Phase = phase
			if err := tx.write(j); err != nil {
				t.Fatal(err)
			}
			before := tree(t, tx.target)
			if err := tx.finish(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) || exists(tx.dir()) {
				t.Fatal("finishing pending fresh commit rolled payload back")
			}
			// NSIS now removes the external receipt and starts an ordinary upgrade.
			tx.freshToken = ""
			if err := tx.prepare(); err != nil {
				t.Fatal(err)
			}
			if err := tx.recover(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) {
				t.Fatal("ordinary next upgrade lost the committed fresh payload")
			}
		})
	}
}

func TestFreshReceiptCannotAuthorizeExistingPayloadOrForeignJournal(t *testing.T) {
	tx, _, manifest, before := fixture(t, false)
	tx.freshToken = "receipt"
	if err := tx.apply(manifest); err == nil {
		t.Fatal("receipt adopted a journal without its token")
	}
	j := journal{Version: 1, Target: tx.target, Phase: "exchanging", FreshToken: tx.freshToken, Previous: []string{"node.exe"}}
	if err := tx.write(j); err != nil {
		t.Fatal(err)
	}
	if err := tx.recover(); err == nil {
		t.Fatal("fresh receipt authorized prior payload replacement")
	}
	j.Previous = nil
	j.Target = filepath.Join(tx.target, "other")
	if err := tx.write(j); err != nil {
		t.Fatal(err)
	}
	if err := tx.recover(); err == nil {
		t.Fatal("receipt authorized another target")
	}
	if !reflect.DeepEqual(tree(t, tx.target), before) {
		t.Fatal("unowned data changed")
	}
}
