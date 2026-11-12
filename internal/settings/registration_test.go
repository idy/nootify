package settings

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitRegistration(t *testing.T, s *Service, status string) RegistrationPage {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		p := s.Registration()
		if p.Status == status {
			return p
		}
		if p.Status == "failed" && status != "failed" {
			t.Fatalf("registration failed: %+v", p)
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("registration never reached %s: %+v", status, s.Registration())
	return RegistrationPage{}
}
func TestNativeRegistrationProtocolKeepsDeviceAndAppSecretsPrivate(t *testing.T) {
	pollStarted, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	registration := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Error("wrong registration content type")
		}
		_ = r.ParseForm()
		switch r.Form.Get("action") {
		case "begin":
			if r.Form.Get("archetype") != "PersonalAgent" || r.Form.Get("auth_method") != "client_secret" || r.Form.Get("request_user_info") != "open_id tenant_brand" {
				t.Error("native protocol changed")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "PRIVATE-DEVICE-CODE", "user_code": "CODE-1234", "expire_in": 600, "interval": 1})
		case "poll":
			if r.Form.Get("device_code") != "PRIVATE-DEVICE-CODE" {
				t.Error("wrong poll code")
			}
			once.Do(func() { close(pollStarted) })
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"client_id": nextApp, "client_secret": "PRIVATE-REGISTERED-SECRET", "user_info": map[string]any{"open_id": "ou_registered", "tenant_brand": "feishu"}})
		default:
			t.Error("unexpected registration action")
		}
	}))
	defer registration.Close()
	upstream := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/open-apis/application/v6/applications/") {
			t.Error("registration enumerated unrelated resources")
		}
		dataReply(w, map[string]any{"app": map[string]any{"scopes": []any{map[string]any{"scope": "im:chat", "token_types": []string{"tenant"}}, map[string]any{"scope": "im:message", "token_types": []string{"tenant"}}, map[string]any{"scope": "im:message.group_msg", "token_types": []string{"tenant"}}}}})
	})
	var reportsMu sync.Mutex
	reports := []map[string]any{}
	s, c := harness(t, func(o *Options) {
		o.RegistrationURL = registration.URL
		o.APIBaseURL = upstream.URL
		o.Report = func(r map[string]any) { reportsMu.Lock(); defer reportsMu.Unlock(); reports = append(reports, r) }
	})
	p, e := s.StartRegistration()
	if e != nil || p.Status != "starting" {
		t.Fatalf("start: %+v %v", p, e)
	}
	select {
	case <-pollStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("not polling")
	}
	p = waitRegistration(t, s, "waiting")
	b, _ := json.Marshal(p)
	if !strings.HasPrefix(p.QR, "data:image/png;base64,") || p.URL != "https://open.feishu.cn/page/cli?user_code=CODE-1234" {
		t.Fatalf("waiting QR: %+v", p)
	}
	if strings.Contains(string(b), "PRIVATE") {
		t.Fatal("device code leaked into page")
	}
	close(release)
	p = waitRegistration(t, s, "complete")
	if p.Setup == nil || p.Setup.Status != "ready" || c.creds.AppID != nextApp || c.recipient != "ou_registered" || c.connectionType != "personal-app" {
		t.Fatalf("registration not accepted: %+v", p)
	}
	reportsMu.Lock()
	b, _ = json.Marshal(reports)
	reportsMu.Unlock()
	if strings.Contains(string(b), "PRIVATE") {
		t.Fatal("secret entered reports")
	}
	b, _ = json.Marshal(p)
	if strings.Contains(string(b), "PRIVATE") {
		t.Fatal("secret entered completion page")
	}
	p, e = s.CancelRegistration()
	if e != nil || p.Status != "complete" || s.Registration().Status != "idle" {
		t.Fatal("cancel concealed completed commit")
	}
}
func TestRegistrationCancellationAbortsPollingAndDoesNotSave(t *testing.T) {
	polling, cancelled := make(chan struct{}), make(chan struct{})
	registration := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("action") == "begin" {
			_, _ = io.WriteString(w, `{"device_code":"device","user_code":"ABCD-1234","expires_in":600}`)
			return
		}
		close(polling)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer registration.Close()
	s, c := harness(t, func(o *Options) { o.RegistrationURL = registration.URL })
	_, _ = s.StartRegistration()
	select {
	case <-polling:
	case <-time.After(3 * time.Second):
		t.Fatal("no poll")
	}
	if p, e := s.CancelRegistration(); e != nil || p.Status != "idle" {
		t.Fatal("cancel failed")
	}
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("poll not cancelled")
	}
	if c.creds.AppID != testApp {
		t.Fatal("cancelled flow saved credentials")
	}
}
func TestRegistrationCannotClaimCancellationDuringCommit(t *testing.T) {
	saving, release := make(chan struct{}), make(chan struct{})
	registration := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("action") == "begin" {
			_, _ = io.WriteString(w, `{"device_code":"device","user_code":"ABCD-1234"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"client_id": nextApp, "client_secret": "new-secret"})
	}))
	defer registration.Close()
	s, _ := harness(t, func(o *Options) {
		o.RegistrationURL = registration.URL
		o.Verify = func(ctx context.Context, c Credentials) error {
			close(saving)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	})
	_, _ = s.StartRegistration()
	select {
	case <-saving:
	case <-time.After(3 * time.Second):
		t.Fatal("save not started")
	}
	if p, e := s.CancelRegistration(); e == nil || p.Status != "connecting" {
		t.Fatal("cancel claimed to undo in-flight save")
	}
	close(release)
	_ = s.Close()
}
func TestRegistrationFailureReasonsAndEnvironmentPrecedence(t *testing.T) {
	for _, reply := range []struct{ body, reason string }{{`{"error":"access_denied"}`, "access_denied"}, {`{"error":"expired_token"}`, "expired_token"}, {`{"error":"invalid_grant"}`, "expired_token"}, {`{"client_id":"cli_bad","client_secret":"secret"}`, "invalid_credentials"}, {`{"user_info":{"tenant_brand":"lark"}}`, "unsupported_brand"}} {
		t.Run(reply.reason, func(t *testing.T) {
			registration := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				if r.Form.Get("action") == "begin" {
					_, _ = io.WriteString(w, `{"device_code":"device","user_code":"ABCD-1234"}`)
				} else {
					_, _ = io.WriteString(w, reply.body)
				}
			}))
			defer registration.Close()
			s, _ := harness(t, func(o *Options) { o.RegistrationURL = registration.URL })
			_, _ = s.StartRegistration()
			if p := waitRegistration(t, s, "failed"); p.Error != reply.reason {
				t.Fatalf("wrong failure: %+v", p)
			}
		})
	}
	s, _ := harness(t, func(o *Options) { o.Env = map[string]string{"LARK_APP_ID": testApp} })
	if _, e := s.StartRegistration(); e == nil {
		t.Fatal("environment override allowed registration")
	}
	if e := s.SaveLark(context.Background(), testApp, "new-secret", nil); e == nil {
		t.Fatal("environment override allowed save")
	}
}
func TestProviderBackupConnectionTypeValidation(t *testing.T) {
	for _, value := range []any{"bot", "personal-app", "invalid", 42, nil, map[string]any{"type": "personal-app"}} {
		provider := map[string]any{"id": "personal", "name": "Personal", "type": "feishu", "enabled": false, "app_id": testApp, "app_secret": "private", "connection_type": value}
		backup := map[string]any{"version": 1, "providers": []any{provider}, "remote": map[string]any{"enabled": false, "listen": "127.0.0.1:9418"}}
		err := validateProviders(backup)
		valid := value == "bot" || value == "personal-app"
		if (err == nil) != valid {
			t.Fatalf("connection type %v accepted=%t", value, err == nil)
		}
	}
	remote := map[string]any{"id": "remote", "name": "Remote", "type": "remote", "enabled": false, "address": "127.0.0.1:9418", "token": "private", "connection_type": "bot"}
	if err := validateProviders(map[string]any{"version": 1, "providers": []any{remote}, "remote": map[string]any{"enabled": false}}); err == nil {
		t.Fatal("remote provider accepted Feishu subtype")
	}
}

func TestSetupIgnoresUserOnlyGrantsAndReportsBotPermissions(t *testing.T) {
	upstream := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
		dataReply(w, map[string]any{"app": map[string]any{"scopes": []any{map[string]any{"scope": "im:chat", "token_types": []string{"user"}}, map[string]any{"scope": "im:message", "token_types": []string{"user"}}}}})
	})
	s, _ := harness(t, func(o *Options) { o.APIBaseURL = upstream.URL })
	setup, e := s.LarkSetup(context.Background(), testApp)
	if e != nil {
		t.Fatal(e)
	}
	if setup.Status != "permissions-required" || !setup.MentionOnly || len(setup.Missing) != 8 || setup.Permission == nil {
		t.Fatalf("bot permissions not reported: %+v", setup)
	}
	for _, scope := range setup.Permission.Scopes {
		if !strings.HasPrefix(scope, "im:") {
			t.Fatal("unrelated scopes included")
		}
	}
}
