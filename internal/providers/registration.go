package providers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/idy/nootify/internal/httpx"
	"github.com/idy/nootify/internal/settings"
)

type RegistrationRecovery struct {
	ID      string `json:"id,omitempty"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}
type RegistrationPage struct {
	settings.RegistrationPage
	RegistrationID string                `json:"registration_id,omitempty"`
	ProviderID     string                `json:"provider_id,omitempty"`
	Recovery       *RegistrationRecovery `json:"recovery,omitempty"`
}
type providerRegistration struct {
	id, providerID, name string
	enabled              bool
	previous             map[string]any
	committed            *settings.RegistrationPage
	failure              string
}

func (s *Service) initRegistration() error {
	var err error
	// This client supplies the QR transport, verification and permission inspection.
	// Provider registration always installs its own commit callback, so it cannot
	// invoke the legacy global-account save or inherit environment credentials.
	s.registrationClient, err = settings.New(settings.Options{
		Store: s.options.Store, Env: map[string]string{}, HTTPClient: s.options.HTTPClient,
		APIBaseURL: s.options.APIBaseURL, RegistrationURL: s.options.RegistrationURL,
		Verify: s.options.Verify, Report: s.options.Report,
	})
	return err
}
func registrationID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
func (s *Service) stopping() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.draining
}
func (s *Service) registrationPageLocked() RegistrationPage {
	r := s.registration
	if r == nil {
		return RegistrationPage{RegistrationPage: settings.RegistrationPage{Status: "idle"}}
	}
	page := s.registrationClient.Registration()
	if r.committed != nil {
		// The returned permission scopes must not alias the retained commit result.
		b, _ := json.Marshal(r.committed)
		_ = json.Unmarshal(b, &page)
	}
	if page.Status == "failed" && r.failure != "" {
		page.Error = r.failure
	}
	result := RegistrationPage{RegistrationPage: page, RegistrationID: r.id}
	if page.Status == "complete" || r.failure == "save_unconfirmed" {
		result.ProviderID = r.providerID
	}
	return result
}
func (s *Service) registrationAvailableLocked() error {
	if s.registration != nil {
		switch s.registrationClient.Registration().Status {
		case "starting", "waiting", "connecting":
			return httpx.Fail(409, "A personal app registration is already active; recover the previous authorization to continue or cancel it")
		}
	}
	return nil
}

// Registration is only exposed through the local, same-origin POST UI gate.
// Recover is deliberately read-only, including after an uncertain save outcome.
func (s *Service) Registration(ctx context.Context, body map[string]any) (RegistrationPage, error) {
	if body["action"] == "start" {
		return s.startRegistration(ctx, body)
	}
	s.registrationMu.Lock()
	defer s.registrationMu.Unlock()
	if body["action"] == "recover" {
		page := s.registrationPageLocked()
		if page.Status == "idle" {
			return RegistrationPage{RegistrationPage: settings.RegistrationPage{Status: "idle"}}, nil
		}
		r := s.registration
		page.Recovery = &RegistrationRecovery{Name: r.name, Enabled: r.enabled}
		if r.previous != nil {
			page.Recovery.ID = r.providerID
		}
		return page, nil
	}
	if body["action"] != "status" && body["action"] != "cancel" {
		return RegistrationPage{}, httpx.Fail(400, "Expected a registration action: start, status, cancel or recover")
	}
	id, err := Identifier(body["registration_id"], "registration_id")
	if err != nil {
		return RegistrationPage{}, err
	}
	r := s.registration
	if r == nil || r.id != id {
		return RegistrationPage{}, httpx.Fail(409, "This registration is no longer active in this tab")
	}
	if body["action"] == "cancel" && r.committed == nil && r.failure != "save_unconfirmed" {
		if _, err = s.registrationClient.CancelRegistration(); err != nil {
			return s.registrationPageLocked(), err
		}
	}
	return s.registrationPageLocked(), nil
}
func (s *Service) startRegistration(ctx context.Context, body map[string]any) (RegistrationPage, error) {
	// A quick availability check prevents a second start from silently queueing
	// behind the first scan's commit and allocating another flow afterwards.
	s.registrationMu.Lock()
	err := s.registrationAvailableLocked()
	s.registrationMu.Unlock()
	if err != nil {
		return RegistrationPage{}, err
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	s.registrationMu.Lock()
	defer s.registrationMu.Unlock()
	if s.stopping() {
		return RegistrationPage{}, httpx.Fail(503, "Notification providers are stopping")
	}
	if err = s.registrationAvailableLocked(); err != nil {
		return RegistrationPage{}, err
	}
	name, err := httpx.Text(body["name"], "name")
	if err != nil {
		return RegistrationPage{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 80 {
		return RegistrationPage{}, httpx.Fail(400, "Provider name must contain 1 to 80 characters")
	}
	enabled, ok := body["enabled"].(bool)
	if !ok {
		return RegistrationPage{}, httpx.Fail(400, "Invalid enabled flag")
	}
	id := "personal-feishu-" + registrationID()
	if _, exists := body["id"]; exists {
		if id, err = Identifier(body["id"], "id"); err != nil {
			return RegistrationPage{}, err
		}
	}
	previous, err := s.providerByID(ctx, id)
	if err != nil {
		return RegistrationPage{}, err
	}
	if _, exists := body["id"]; exists {
		if previous == nil || previous["type"] != "feishu" || previous["connection_type"] != "personal-app" {
			return RegistrationPage{}, httpx.Fail(409, "Select an existing Feishu personal app channel to reauthorize")
		}
	} else if previous != nil {
		return RegistrationPage{}, httpx.Fail(409, "The new provider ID is already in use")
	}
	if err = ctx.Err(); err != nil {
		return RegistrationPage{}, err
	}
	if s.stopping() {
		return RegistrationPage{}, httpx.Fail(503, "Notification providers are stopping")
	}
	r := &providerRegistration{id: registrationID(), providerID: id, name: name, enabled: enabled, previous: previous}
	_, err = s.registrationClient.StartRegistrationWith(func(ctx context.Context, c settings.Credentials, recipient string) (settings.Setup, error) {
		return s.acceptRegistration(ctx, r, c, recipient)
	})
	if err != nil {
		return RegistrationPage{}, err
	}
	s.registration = r
	return s.registrationPageLocked(), nil
}
func (s *Service) providerByID(ctx context.Context, id string) (map[string]any, error) {
	_, providers, err := s.providerConfig(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range providers {
		if p["id"] == id {
			return p, nil
		}
	}
	return nil, nil
}
func (s *Service) inspectSetup(ctx context.Context, c settings.Credentials) (settings.Setup, error) {
	if s.options.Setup != nil {
		return s.options.Setup(ctx, c)
	}
	return s.registrationClient.InspectSetup(ctx, c)
}
func (s *Service) Setup(ctx context.Context, id string) (settings.Setup, error) {
	if _, err := Identifier(id, "id"); err != nil {
		return settings.Setup{}, err
	}
	p, err := s.providerByID(ctx, id)
	if err != nil {
		return settings.Setup{}, err
	}
	if p == nil {
		return settings.Setup{}, httpx.Fail(404, "Notification provider not found")
	}
	if p["type"] != "feishu" {
		return settings.Setup{}, httpx.Fail(400, "Permission setup requires a Feishu provider")
	}
	c := settings.Credentials{AppID: str(p["app_id"]), AppSecret: str(p["app_secret"])}
	setup, err := s.inspectSetup(ctx, c)
	if err != nil {
		return settings.Setup{}, err
	}
	current, err := s.providerByID(ctx, id)
	if err != nil {
		return settings.Setup{}, err
	}
	if current == nil || current["type"] != "feishu" || current["app_id"] != c.AppID || current["app_secret"] != c.AppSecret {
		return settings.Setup{}, httpx.Fail(409, "Feishu credentials changed; check permissions again")
	}
	return setup, nil
}

var registrationRecipient = regexp.MustCompile(`^ou_[A-Za-z0-9]+$`)

func (s *Service) registrationFailure(r *providerRegistration, reason string) error {
	s.registrationMu.Lock()
	r.failure = reason
	s.registrationMu.Unlock()
	return httpx.Fail(409, reason)
}
func (s *Service) acceptRegistration(ctx context.Context, r *providerRegistration, c settings.Credentials, recipient string) (settings.Setup, error) {
	if !registrationRecipient.MatchString(recipient) {
		return settings.Setup{}, s.registrationFailure(r, "missing_recipient")
	}
	if r.previous != nil && r.previous["app_id"] != c.AppID {
		return settings.Setup{}, s.registrationFailure(r, "app_mismatch")
	}
	if err := ctx.Err(); err != nil {
		return settings.Setup{}, err
	}
	if err := s.registrationClient.VerifyCredentials(ctx, c); err != nil {
		return settings.Setup{}, err
	}
	if err := ctx.Err(); err != nil {
		return settings.Setup{}, err
	}
	setup, err := s.inspectSetup(ctx, c)
	if err != nil {
		setup = settings.Setup{AppID: c.AppID, Status: "unavailable", Missing: []string{}}
	}
	if err := ctx.Err(); err != nil {
		return settings.Setup{}, err
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	if s.stopping() {
		return settings.Setup{}, httpx.Fail(503, "Notification providers are stopping")
	}
	if err = s.repairCompatibilityMirror(); err != nil {
		return settings.Setup{}, err
	}
	p := map[string]any{"id": r.providerID, "type": "feishu", "connection_type": "personal-app", "name": r.name, "enabled": r.enabled,
		"app_id": c.AppID, "app_secret": c.AppSecret, "recipient_open_id": recipient}
	if err = s.checkEnvironmentMutation(ctx, "provider.save", p); err != nil {
		return settings.Setup{}, err
	}
	// Recheck after compatibility preflight, under the same mutation lock as
	// deletes, reconnects, config imports and all ordinary provider saves.
	current, err := s.providerByID(ctx, r.providerID)
	if err != nil {
		return settings.Setup{}, err
	}
	s.registrationMu.Lock()
	stale := s.registration != r || !reflect.DeepEqual(current, r.previous)
	s.registrationMu.Unlock()
	if stale {
		return settings.Setup{}, s.registrationFailure(r, "target_changed")
	}
	if err = ctx.Err(); err != nil {
		return settings.Setup{}, err
	}
	// Once admitted, reconcile the actual local commit even if shutdown cancels
	// verification's context. Never replay a save whose outcome is unknown.
	commitCtx := context.WithoutCancel(ctx)
	_, err = s.raw(commitCtx, "provider.save", p)
	if !committedMutation(err) {
		if !provenRejection(err) {
			return settings.Setup{}, s.registrationFailure(r, "save_unconfirmed")
		}
		return settings.Setup{}, err
	}
	warning := ""
	if err != nil {
		warning = errorCode(err)
	}
	if r.providerID == s.compatID {
		if mirrorErr := s.mirrorCompatibility(commitCtx); mirrorErr != nil && warning == "" {
			warning = errorCode(mirrorErr)
			if warning == "" {
				warning = "provider_status_unavailable"
			}
		}
	}
	if _, statusErr := s.Page(commitCtx); statusErr != nil && warning == "" {
		warning = "provider_status_unavailable"
	}
	s.registrationMu.Lock()
	r.committed = &settings.RegistrationPage{Status: "complete", AppID: c.AppID, Setup: &setup, Error: warning}
	s.registrationMu.Unlock()
	if warning != "" {
		s.report(map[string]any{"status": "personal_app_committed_warning", "reason": warning})
	}
	return setup, nil
}

func (s *Service) reconnect(ctx context.Context, id string) (map[string]any, error) {
	// Core reads and restarts the saved configuration atomically. It performs no
	// save, so even an intentionally empty default and unknown subtype survive.
	if _, err := s.Call(ctx, "provider.reconnect", map[string]any{"id": id}); err != nil {
		return nil, err
	}
	return s.Page(ctx)
}
