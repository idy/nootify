package providers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idy/nootify/internal/settings"
	core "github.com/idy/nootify/native/core"
)

func scanReply(app, recipient string) map[string]any {
	return map[string]any{"client_id": app, "client_secret": "PRIVATE-REGISTERED-SECRET", "user_info": map[string]any{"open_id": recipient, "tenant_brand": "feishu"}}
}
func registrationHarness(t *testing.T, poll func(context.Context) map[string]any, configure func(*Options)) *Service {
	t.Helper()
	s := compatibilityHarness(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("action") == "begin" {
			if r.Form.Get("archetype") != "PersonalAgent" || r.Form.Get("request_user_info") != "open_id tenant_brand" {
				t.Error("registration protocol changed")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "PRIVATE-DEVICE-CODE", "user_code": "CODE-1234", "expires_in": 600})
			return
		}
		if r.Form.Get("device_code") != "PRIVATE-DEVICE-CODE" {
			t.Error("missing device code")
		}
		_ = json.NewEncoder(w).Encode(poll(r.Context()))
	}))
	t.Cleanup(upstream.Close)
	s.options.RegistrationURL = upstream.URL
	s.options.Verify = func(context.Context, settings.Credentials) error { return nil }
	s.options.Setup = func(_ context.Context, c settings.Credentials) (settings.Setup, error) {
		return settings.Setup{AppID: c.AppID, Status: "ready", Missing: []string{}}, nil
	}
	if configure != nil {
		configure(&s.options)
	}
	if err := s.initRegistration(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.registrationClient.Close() })
	return s
}
func startScan(t *testing.T, s *Service, id string) RegistrationPage {
	t.Helper()
	body := map[string]any{"action": "start", "name": "My personal app", "enabled": false}
	if id != "" {
		body["id"] = id
	}
	p, err := s.Registration(context.Background(), body)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func scanAction(t *testing.T, s *Service, action string, p RegistrationPage) RegistrationPage {
	t.Helper()
	result, err := s.Registration(context.Background(), map[string]any{"action": action, "registration_id": p.RegistrationID})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func scanOutcome(t *testing.T, s *Service, p RegistrationPage, status string) RegistrationPage {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		p = scanAction(t, s, "status", p)
		if p.Status == status {
			return p
		}
		if p.Status == "failed" || p.Status == "complete" {
			t.Fatalf("unexpected scan outcome: %+v", p)
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("scan never reached %s: %+v", status, p)
	return p
}
func await(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("operation did not reach gate")
	}
}
func seedPersonal(t *testing.T, s *Service, id, app string) {
	t.Helper()
	seedProvider(t, s, id, app, "PRIVATE-EXISTING-SECRET", false)
	if err := s.store.Update(func(d *core.State) error {
		p := d.Providers[id]
		p.ConnectionType = "personal-app"
		d.Providers[id] = p
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPersonalRegistrationPreservesExistingDefaultAndPrivateCredentials(t *testing.T) {
	var reportsMu sync.Mutex
	var reports []map[string]any
	s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(appB, "ou_scanner") }, func(o *Options) {
		o.Report = func(record map[string]any) {
			reportsMu.Lock()
			defer reportsMu.Unlock()
			reports = append(reports, record)
		}
	})
	seedProvider(t, s, "legacy-feishu", appA, "PRIVATE-EXISTING-SECRET", false)
	if err := s.reconcileCredentials(context.Background(), Credentials{AppID: appA, AppSecret: "PRIVATE-EXISTING-SECRET", Source: "environment"}); err != nil {
		t.Fatal(err)
	}
	before := s.store.Snapshot()
	p := scanOutcome(t, s, startScan(t, s, ""), "complete")
	after := s.store.Snapshot()
	provider := after.Providers[p.ProviderID]
	if provider.AppID != appB || provider.AppSecret != "PRIVATE-REGISTERED-SECRET" || provider.Recipient != "ou_scanner" || provider.ConnectionType != "personal-app" || provider.Enabled {
		t.Fatalf("wrong new provider: id=%s type=%s", provider.ID, provider.ConnectionType)
	}
	if !reflect.DeepEqual(before.Providers["legacy-feishu"], after.Providers["legacy-feishu"]) || after.DefaultProvider != before.DefaultProvider {
		t.Fatal("new personal scan replaced the previous/default channel")
	}
	if s.options.Store.Setting("lark_app_id") != appA || s.options.Store.Setting("lark_app_secret") != "PRIVATE-EXISTING-SECRET" {
		t.Fatal("new personal scan replaced global credentials")
	}
	cancelled := scanAction(t, s, "cancel", p)
	recovered := scanAction(t, s, "recover", p)
	if cancelled.Status != "complete" || recovered.Status != "complete" || recovered.Recovery == nil || recovered.Recovery.ID != "" || recovered.Recovery.Name != "My personal app" || recovered.Recovery.Enabled {
		t.Fatalf("committed outcome not recoverable: %+v", recovered)
	}
	page, err := s.Page(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	reportsMu.Lock()
	encoded, _ := json.Marshal([]any{p, cancelled, recovered, page, reports})
	reportsMu.Unlock()
	if strings.Contains(string(encoded), "PRIVATE") || strings.Contains(string(encoded), "app_secret") || strings.Contains(string(encoded), "device_code") {
		t.Fatal("public registration state or reports exposed a secret")
	}
}
func TestRegistrationRecoveryAndCancellationAreScopedAndReadOnly(t *testing.T) {
	polling, cancelled := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s := registrationHarness(t, func(ctx context.Context) map[string]any {
		if calls.Add(1) == 1 {
			close(polling)
			<-ctx.Done()
			close(cancelled)
			return scanReply(appB, "ou_scanner")
		}
		<-ctx.Done()
		return nil
	}, nil)
	first := startScan(t, s, "")
	await(t, polling)
	waiting := scanOutcome(t, s, first, "waiting")
	if !strings.HasPrefix(waiting.QR, "data:image/png;base64,") || strings.Contains(waiting.QR, "PRIVATE") {
		t.Fatal("invalid QR page")
	}
	for _, action := range []string{"status", "cancel"} {
		if _, err := s.Registration(context.Background(), map[string]any{"action": action, "registration_id": "other-tab"}); Status(err) != 409 {
			t.Fatalf("unscoped %s: %v", action, err)
		}
	}
	recovered := scanAction(t, s, "recover", RegistrationPage{})
	if recovered.RegistrationID != first.RegistrationID || recovered.Recovery == nil || recovered.Recovery.ID != "" {
		t.Fatal("lost response recovery retargeted flow")
	}
	if _, err := s.Registration(context.Background(), map[string]any{"action": "start", "name": "Another app", "enabled": true}); Status(err) != 409 {
		t.Fatalf("second active scan admitted: %v", err)
	}
	if page := scanAction(t, s, "cancel", recovered); page.Status != "idle" {
		t.Fatal("cancellation did not settle")
	}
	await(t, cancelled)
	second := startScan(t, s, "")
	if first.RegistrationID == second.RegistrationID {
		t.Fatal("registration ID reused")
	}
	if _, err := s.Registration(context.Background(), map[string]any{"action": "cancel", "registration_id": first.RegistrationID}); Status(err) != 409 {
		t.Fatal("old tab cancelled new scan")
	}
	if len(s.store.Snapshot().Providers) != 0 {
		t.Fatal("cancelled scan committed late credentials")
	}
	_ = scanAction(t, s, "cancel", second)
}
func TestRegistrationReauthorizationChecksPersonalTypeAppAndRecipient(t *testing.T) {
	for _, test := range []struct{ name, app, recipient, reason string }{
		{"wrong-app", appB, "ou_scanner", "app_mismatch"},
		{"missing-recipient", appA, "", "missing_recipient"},
		{"invalid-recipient", appA, "ou_bad_recipient", "missing_recipient"},
		{"same-app", appA, "ou_scanner", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(test.app, test.recipient) }, nil)
			seedPersonal(t, s, "personal-one", appA)
			seedProvider(t, s, "bot", appB, "bot-secret", false)
			for _, id := range []string{"bot", "missing"} {
				if _, err := s.Registration(context.Background(), map[string]any{"action": "start", "id": id, "name": "Invalid", "enabled": false}); Status(err) != 409 {
					t.Fatalf("accepted target %s: %v", id, err)
				}
			}
			status := "failed"
			if test.reason == "" {
				status = "complete"
			}
			p := scanOutcome(t, s, startScan(t, s, "personal-one"), status)
			if p.Error != test.reason {
				t.Fatalf("wrong registration failure: %+v", p)
			}
			stored := s.store.Snapshot().Providers["personal-one"]
			if test.reason != "" && stored.AppSecret != "PRIVATE-EXISTING-SECRET" {
				t.Fatal("rejected scan changed credentials")
			}
			if test.reason == "" && (stored.AppSecret != "PRIVATE-REGISTERED-SECRET" || p.ProviderID != "personal-one") {
				t.Fatal("same-App-ID scan did not reauthorize target")
			}
		})
	}
}
func TestRegistrationFailuresAreSanitizedAndPermissionFailureDoesNotUndoSave(t *testing.T) {
	for _, verification := range []bool{true, false} {
		t.Run(map[bool]string{true: "verification", false: "permissions"}[verification], func(t *testing.T) {
			s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(appA, "ou_scanner") }, func(o *Options) {
				if verification {
					o.Verify = func(context.Context, settings.Credentials) error {
						return errors.New("PRIVATE-SECRET upstream failure")
					}
				}
				o.Setup = func(context.Context, settings.Credentials) (settings.Setup, error) {
					return settings.Setup{}, errors.New("PRIVATE-SECRET permission failure")
				}
			})
			status := "complete"
			if verification {
				status = "failed"
			}
			p := scanOutcome(t, s, startScan(t, s, ""), status)
			if verification {
				if p.Error != "save_failed" || len(s.store.Snapshot().Providers) != 0 {
					t.Fatal("verification failure leaked or saved")
				}
			} else if p.Setup == nil || p.Setup.Status != "unavailable" || len(s.store.Snapshot().Providers) != 1 {
				t.Fatal("permission failure undid a save")
			}
		})
	}
}
func TestRegistrationSaveOutcomesAreRetainedWithoutReplay(t *testing.T) {
	for _, code := range []string{"committed_not_durable", "unconfirmed", "conflict", "status-loss", "unknown"} {
		t.Run(code, func(t *testing.T) {
			s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(appA, "ou_scanner") }, nil)
			var saves atomic.Int32
			s.coreHandle = func(ctx context.Context, method string, raw json.RawMessage, local bool) (any, error) {
				if method == "provider.save" {
					saves.Add(1)
					if code == "conflict" {
						return nil, compatibilityFault(code, "synthetic precommit rejection")
					}
					result, err := s.core.Handle(ctx, method, raw, local)
					if err != nil {
						return result, err
					}
					if code == "status-loss" {
						return result, nil
					}
					if code == "unknown" {
						return nil, errors.New("PRIVATE-UNKNOWN-SAVE-ERROR")
					}
					return result, compatibilityFault(code, "synthetic save outcome")
				}
				if method == "status" && code == "status-loss" && saves.Load() > 0 {
					return nil, compatibilityFault("unavailable", "synthetic lost status")
				}
				return s.core.Handle(ctx, method, raw, local)
			}
			status, reason := "complete", code
			if code == "unconfirmed" || code == "unknown" {
				status, reason = "failed", "save_unconfirmed"
			}
			if code == "conflict" {
				status, reason = "failed", "save_failed"
			}
			if code == "status-loss" {
				reason = "provider_status_unavailable"
			}
			p := scanOutcome(t, s, startScan(t, s, ""), status)
			for _, action := range []string{"status", "cancel", "recover", "recover"} {
				settled := scanAction(t, s, action, p)
				if code != "conflict" && (settled.Status != status || settled.Error != reason || settled.ProviderID == "") {
					t.Fatalf("lost %s outcome during %s: %+v", code, action, settled)
				}
			}
			if saves.Load() != 1 {
				t.Fatalf("save replayed %d times", saves.Load())
			}
		})
	}
}
func TestRegistrationCommittedLegacyReauthorizationSurvivesMirrorFailure(t *testing.T) {
	s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(appA, "ou_scanner") }, nil)
	seedPersonal(t, s, "legacy-feishu", appA)
	s.coreHandle = func(ctx context.Context, method string, raw json.RawMessage, local bool) (any, error) {
		result, err := s.core.Handle(ctx, method, raw, local)
		if method == "provider.save" && err == nil {
			_ = s.options.Store.Close()
		}
		return result, err
	}
	p := scanOutcome(t, s, startScan(t, s, "legacy-feishu"), "complete")
	if p.Error != "committed_not_mirrored" || p.ProviderID != "legacy-feishu" {
		t.Fatalf("committed scan misreported: %+v", p)
	}
	if s.store.Snapshot().Providers[p.ProviderID].AppSecret != "PRIVATE-REGISTERED-SECRET" {
		t.Fatal("mirror failure rolled back provider authority")
	}
}
func TestRegistrationStaleTargetCheckRunsInsideMutationQueue(t *testing.T) {
	for _, change := range []string{"delete", "rename", "import"} {
		t.Run(change, func(t *testing.T) {
			inspecting, release := make(chan struct{}), make(chan struct{})
			s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(appA, "ou_scanner") }, func(o *Options) {
				o.Setup = func(ctx context.Context, c settings.Credentials) (settings.Setup, error) {
					close(inspecting)
					select {
					case <-release:
					case <-ctx.Done():
						return settings.Setup{}, ctx.Err()
					}
					return settings.Setup{AppID: c.AppID, Status: "ready", Missing: []string{}}, nil
				}
			})
			seedPersonal(t, s, "personal-one", appA)
			p := startScan(t, s, "personal-one")
			await(t, inspecting)
			var err error
			switch change {
			case "delete":
				_, err = s.Call(context.Background(), "provider.delete", map[string]any{"id": "personal-one"})
			case "rename":
				config, e := s.providerByID(context.Background(), "personal-one")
				if e != nil {
					t.Fatal(e)
				}
				config["name"] = "Changed while scanning"
				_, err = s.Call(context.Background(), "provider.save", config)
			case "import":
				_, err = s.Call(context.Background(), "config.import", importedBackup("personal-one", appA, "changed-secret"))
			}
			if err != nil {
				t.Fatal(err)
			}
			close(release)
			p = scanOutcome(t, s, p, "failed")
			if p.Error != "target_changed" {
				t.Fatalf("stale registration accepted: %+v", p)
			}
		})
	}
}
func TestConcurrentRegistrationStartsAllocateOneFlow(t *testing.T) {
	s := registrationHarness(t, func(ctx context.Context) map[string]any { <-ctx.Done(); return nil }, nil)
	var group sync.WaitGroup
	var accepted atomic.Int32
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := s.Registration(context.Background(), map[string]any{"action": "start", "name": "Personal", "enabled": false})
			if err == nil {
				accepted.Add(1)
			} else if Status(err) != 409 {
				t.Errorf("unexpected start error: %v", err)
			}
		}()
	}
	group.Wait()
	if accepted.Load() != 1 {
		t.Fatalf("allocated %d flows", accepted.Load())
	}
	p := scanAction(t, s, "recover", RegistrationPage{})
	_ = scanAction(t, s, "cancel", p)
}
func TestRegistrationCancelRefusedDuringSaveAndShutdownReconcilesCommit(t *testing.T) {
	saving, release := make(chan struct{}), make(chan struct{})
	s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(appA, "ou_scanner") }, nil)
	s.coreHandle = func(ctx context.Context, method string, raw json.RawMessage, local bool) (any, error) {
		if method == "provider.save" {
			close(saving)
			<-release
		}
		return s.core.Handle(ctx, method, raw, local)
	}
	p := startScan(t, s, "")
	await(t, saving)
	if _, err := s.Registration(context.Background(), map[string]any{"action": "cancel", "registration_id": p.RegistrationID}); Status(err) != 409 {
		t.Fatalf("claimed saving was cancelled: %v", err)
	}
	if recovered := scanAction(t, s, "recover", p); recovered.Status != "connecting" {
		t.Fatal("saving flow not recoverable")
	}
	closed := make(chan struct{})
	go func() { _ = s.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("shutdown failed to wait for save")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	await(t, closed)
	if complete := scanAction(t, s, "status", p); complete.Status != "complete" {
		t.Fatalf("shutdown concealed committed outcome: %+v", complete)
	}
}
func TestRegistrationShutdownCancelsVerificationBeforeSaving(t *testing.T) {
	verifying := make(chan struct{})
	s := registrationHarness(t, func(context.Context) map[string]any { return scanReply(appA, "ou_scanner") }, func(o *Options) {
		o.Verify = func(ctx context.Context, _ settings.Credentials) error {
			close(verifying)
			<-ctx.Done()
			return ctx.Err()
		}
	})
	_ = startScan(t, s, "")
	await(t, verifying)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if len(s.store.Snapshot().Providers) != 0 {
		t.Fatal("shutdown allowed credential commit")
	}
	if _, err := s.Registration(context.Background(), map[string]any{"action": "start", "name": "After shutdown", "enabled": false}); err == nil {
		t.Fatal("shutdown admitted a scan")
	}
}
func TestReconnectPreservesSavedConfigAndCannotResurrectDeletedProvider(t *testing.T) {
	s := registrationHarness(t, func(context.Context) map[string]any { return nil }, nil)
	seedPersonal(t, s, "legacy-feishu", appA)
	seedProvider(t, s, "another", appB, "other-secret", false)
	var restarts atomic.Int32
	s.coreHandle = func(ctx context.Context, method string, raw json.RawMessage, local bool) (any, error) {
		if method == "provider.reconnect" {
			restarts.Add(1)
		}
		if method == "provider.save" {
			t.Error("reconnect attempted a provider save")
		}
		return s.core.Handle(ctx, method, raw, local)
	}
	for _, defaultID := range []string{"legacy-feishu", "another", ""} {
		if err := s.store.Update(func(d *core.State) error { d.DefaultProvider = defaultID; return nil }); err != nil {
			t.Fatal(err)
		}
		before := s.store.Snapshot()
		if _, err := s.Action(context.Background(), map[string]any{"action": "reconnect", "id": "legacy-feishu", "provider": map[string]any{"app_secret": "attacker-secret"}}); err != nil {
			t.Fatal(err)
		}
		after := s.store.Snapshot()
		if !reflect.DeepEqual(before.Providers, after.Providers) || after.DefaultProvider != before.DefaultProvider {
			t.Fatal("reconnect modified configuration")
		}
	}
	if restarts.Load() != 3 {
		t.Fatal("reconnect skipped runtime restart")
	}
	s.ops.Lock()
	started, finished := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		_, err := s.Action(context.Background(), map[string]any{"action": "reconnect", "id": "another"})
		finished <- err
	}()
	await(t, started)
	_, err := s.raw(context.Background(), "provider.delete", map[string]any{"id": "another"})
	s.ops.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err = <-finished; Status(err) != 404 {
		t.Fatalf("reconnect used stale config: %v", err)
	}
	if _, exists := s.store.Snapshot().Providers["another"]; exists {
		t.Fatal("reconnect resurrected deleted provider")
	}
}
func TestProviderSetupUsesSelectedCredentialsAndRejectsChangedTarget(t *testing.T) {
	inspecting, release := make(chan struct{}), make(chan struct{})
	var observed settings.Credentials
	s := registrationHarness(t, func(context.Context) map[string]any { return nil }, func(o *Options) {
		o.Setup = func(ctx context.Context, c settings.Credentials) (settings.Setup, error) {
			observed = c
			close(inspecting)
			select {
			case <-release:
			case <-ctx.Done():
				return settings.Setup{}, ctx.Err()
			}
			return settings.Setup{AppID: c.AppID, Status: "ready", Missing: []string{}}, nil
		}
	})
	seedProvider(t, s, "legacy-feishu", appA, "global-secret", false)
	seedPersonal(t, s, "selected", appB)
	finished := make(chan error, 1)
	go func() { _, err := s.Setup(context.Background(), "selected"); finished <- err }()
	await(t, inspecting)
	if observed.AppID != appB || observed.AppSecret != "PRIVATE-EXISTING-SECRET" {
		t.Fatal("setup checked global credentials")
	}
	p, err := s.providerByID(context.Background(), "selected")
	if err != nil {
		t.Fatal(err)
	}
	p["app_secret"] = "rotated-secret"
	if _, err = s.Call(context.Background(), "provider.save", p); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err = <-finished; Status(err) != 409 {
		t.Fatalf("stale setup accepted: %v", err)
	}
	if _, err = s.Setup(context.Background(), "missing"); Status(err) != 404 {
		t.Fatal("missing provider permissions accepted")
	}
}
