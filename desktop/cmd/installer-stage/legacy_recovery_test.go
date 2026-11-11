package main

import (
	"errors"
	"reflect"
	"testing"
)

type legacyFixtureService struct {
	*fakeService
	receipt      string
	captureError error
	restore      func(string, serviceState) error
}

func (s *legacyFixtureService) captureRegistration() (string, error) {
	s.calls = append(s.calls, "capture")
	return s.receipt, s.captureError
}
func (s *legacyFixtureService) restoreRegistration(receipt string, state serviceState) error {
	s.calls = append(s.calls, "restore-registration")
	if err := s.restore(receipt, state); err != nil {
		return err
	}
	s.active, s.enabled = state.Running, state.Enabled
	return nil
}

func TestLegacyRollbackReceiptSurvivesHelperRestart(t *testing.T) {
	for _, running := range []bool{false, true} {
		for _, enabled := range []bool{false, true} {
			t.Run(map[bool]string{false: "idle", true: "running"}[running]+map[bool]string{false: "/disabled", true: "/enabled"}[enabled], func(t *testing.T) {
				tx, service, manifest, before := fixture(t, running)
				service.enabled = enabled
				legacy := &legacyFixtureService{fakeService: service, receipt: "original owned v1 XML"}
				tx.service = legacy
				tx.checkpoint = func(point string) error {
					if point == "ready" {
						panic("installer interrupted after migration")
					}
					return nil
				}
				func() {
					defer func() {
						if recover() == nil {
							t.Fatal("expected interruption")
						}
					}()
					_ = tx.apply(manifest)
				}()
				j, err := tx.read()
				if err != nil || j.LegacyTask != legacy.receipt {
					t.Fatal("missing durable original registration", err)
				}
				if !reflect.DeepEqual(service.calls[:3], []string{"status", "capture", "stop"}) {
					t.Fatal("receipt captured after stop", service.calls)
				}
				// A new helper has no in-memory copy of the original registration.
				legacy.receipt = ""
				attempts := 0
				legacy.restore = func(receipt string, state serviceState) error {
					attempts++
					if receipt != j.LegacyTask || state != (serviceState{Running: running, Enabled: enabled}) {
						t.Fatal("wrong rollback identity or state", receipt, state)
					}
					if !reflect.DeepEqual(tree(t, tx.target), before) {
						t.Fatal("registration restored before original files")
					}
					if attempts == 1 {
						return errors.New("owned recovery refused; retain journal for retry")
					}
					return nil
				}
				retry := transaction{target: tx.target, service: legacy}
				if err := retry.recover(); err == nil {
					t.Fatal("missing recovery refusal")
				}
				j, err = retry.read()
				if err != nil || j.Phase != "restored" || j.LegacyTask == "" {
					t.Fatal("failed restore lost receipt", err)
				}
				if err := retry.recover(); err != nil {
					t.Fatal(err)
				}
				if service.active != running || service.enabled != enabled || exists(tx.dir()) {
					t.Fatal("original state was not restored")
				}
				starts := 0
				for _, call := range service.calls {
					if call == "start" {
						starts++
					}
				}
				wantStarts := 0
				if running {
					wantStarts = 1
				} // Only the new payload uses generic start.
				if starts != wantStarts {
					t.Fatal("rollback invoked generic start on old GUI", service.calls)
				}
			})
		}
	}
}

func TestLegacyReceiptCaptureRefusalDoesNotStopOrExchange(t *testing.T) {
	tx, service, manifest, before := fixture(t, true)
	tx.service = &legacyFixtureService{fakeService: service, captureError: errors.New("modified task identity")}
	if err := tx.apply(manifest); err == nil {
		t.Fatal("missing ownership refusal")
	}
	if !reflect.DeepEqual(service.calls, []string{"status", "capture"}) || !reflect.DeepEqual(tree(t, tx.target), before) {
		t.Fatal("capture refusal modified installation")
	}
}
