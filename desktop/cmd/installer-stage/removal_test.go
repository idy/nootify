package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestUninstallQuarantineFailuresRestoreManagementAndRetryEntry(t *testing.T) {
	for _, root := range payloadRoots {
		if root == "uninstall.exe" {
			continue
		}
		t.Run(root, func(t *testing.T) {
			tx, service, _, before := fixture(t, false)
			if err := tx.recover(); err != nil {
				t.Fatal(err)
			}
			tx.checkpoint = func(name string) error {
				if name == "remove-backup:"+root {
					return errors.New("sharing violation")
				}
				return nil
			}
			if err := tx.remove(); err == nil {
				t.Fatal("missing quarantine failure")
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) {
				t.Fatal("failed quarantine changed management payload or uninstaller")
			}
			if len(service.calls) != 0 {
				t.Fatal("removal performed extra service actions")
			}
			tx.checkpoint = nil
			if err := tx.remove(); err != nil {
				t.Fatal(err)
			}
			assertRemovedPayload(t, tx, before)
		})
	}
}

func assertRemovedPayload(t *testing.T, tx transaction, before map[string]string) {
	t.Helper()
	files := tree(t, tx.target)
	want := map[string]string{"uninstall.exe": before["uninstall.exe"], "unrelated.txt": before["unrelated.txt"], filepath.Join("state", "private-marker"): before[filepath.Join("state", "private-marker")]}
	if !reflect.DeepEqual(files, want) || exists(tx.dir()) {
		t.Fatal("removal lost retry entry/private files or retained payload", files)
	}
}

func TestUninstallDeleteFailuresAndInterruptionRetainDurableRetry(t *testing.T) {
	for _, root := range payloadRoots {
		if root == "uninstall.exe" {
			continue
		}
		for _, crash := range []bool{false, true} {
			t.Run(root+map[bool]string{false: "/failure", true: "/interruption"}[crash], func(t *testing.T) {
				tx, service, _, before := fixture(t, false)
				if err := tx.recover(); err != nil {
					t.Fatal(err)
				}
				tx.checkpoint = func(name string) error {
					if name == "remove-deleted:"+root {
						if crash {
							panic("interrupted removal")
						}
						return errors.New("locked next entry")
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
						_ = tx.remove()
					}()
				} else if err := tx.remove(); err == nil {
					t.Fatal("missing removal failure")
				}
				if !exists(filepath.Join(tx.target, "uninstall.exe")) || !exists(tx.dir("journal.json")) {
					t.Fatal("uninstaller or retry journal disappeared")
				}
				if exists(filepath.Join(tx.target, "node.exe")) || exists(filepath.Join(tx.target, "service")) {
					t.Fatal("partial removal was exposed as active installed management payload")
				}
				tx.checkpoint = nil
				if err := tx.remove(); err != nil {
					t.Fatal(err)
				}
				assertRemovedPayload(t, tx, before)
				if len(service.calls) != 0 {
					t.Fatal("retry touched service state")
				}
			})
		}
	}
}

func TestInterruptedQuarantineRestoresCLIForUninstallerRetry(t *testing.T) {
	for _, root := range payloadRoots {
		if root == "uninstall.exe" {
			continue
		}
		t.Run(root, func(t *testing.T) {
			tx, _, _, before := fixture(t, false)
			if err := tx.recover(); err != nil {
				t.Fatal(err)
			}
			tx.checkpoint = func(name string) error {
				if name == "remove-backed-up:"+root {
					panic("interrupted quarantine")
				}
				return nil
			}
			func() {
				defer func() {
					if recover() == nil {
						t.Fatal("missing interruption")
					}
				}()
				_ = tx.remove()
			}()
			tx.checkpoint = nil
			if err := tx.recover(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(tree(t, tx.target), before) || exists(tx.dir()) {
				t.Fatal("retry lacks its intact management CLI/uninstaller")
			}
			if err := tx.remove(); err != nil {
				t.Fatal(err)
			}
			assertRemovedPayload(t, tx, before)
		})
	}
}

func TestUninstallJournalCannotRemoveUninstallerOrUnownedRoots(t *testing.T) {
	tx, _, _, before := fixture(t, false)
	if err := tx.recover(); err != nil {
		t.Fatal(err)
	}
	if err := tx.prepare(); err != nil {
		t.Fatal(err)
	}
	for _, roots := range [][]string{{"uninstall.exe"}, {"state"}, {"../outside"}} {
		j := journal{Version: 1, Target: tx.target, Phase: "removing", Previous: roots}
		if err := tx.write(j); err != nil {
			t.Fatal(err)
		}
		if err := tx.remove(); err == nil {
			t.Fatal("unsafe removal journal accepted", roots)
		}
		if !reflect.DeepEqual(tree(t, tx.target), before) {
			t.Fatal("unsafe removal journal changed payload")
		}
	}
	// A missing file is idempotent during an interrupted deletion retry.
	if err := os.Remove(tx.dir("journal.json")); err != nil {
		t.Fatal(err)
	}
}
