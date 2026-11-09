package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/idy/nootify/desktop/internal/language"
	"github.com/idy/nootify/desktop/internal/service"
	"github.com/idy/nootify/desktop/internal/updater"
)

// The packager supplies these from root package.json and the bundle identity.
var version = "0.0.0-dev"
var appID = "dev.idy.nootify"

type shell struct {
	ctx            context.Context
	cancel         context.CancelFunc
	smoke          bool
	smokeLoads     smokeLoadDiagnostics
	offline        *offlineServer
	policy         urlPolicy
	window         *mygo.Window
	tray           *mygo.Tray
	menu           *mygo.Menu
	nativeMenu     *mygo.Menu
	language       *language.Store
	service        *service.Manager
	updates        *updater.Manager
	update         updater.View
	requests       chan string
	updateRequests chan string
	pageRequests   atomic.Uint64
	evaluations    pageEvaluator
	quitting       bool
	pageLoadState
	ui                   *service.OwnedUI
	health               *service.Health
	healthError          error
	installed            bool
	actionPending        bool
	action               language.Text
	actionError          error
	moduleLabels         []string
	serviceHandoff       *serviceHandoff
	updateShutdown       updateShutdown
	startupGate          <-chan struct{}
	suppressServiceStart bool
	guiHandoff           *updater.GUIClient
	guiReady             chan struct{}
	guiInitialized       bool
	guiDocumentLoaded    bool
	guiSignaled          bool
	updateRelaunch       bool
}

func main() {
	if slices.Contains(os.Args[1:], "--version") {
		fmt.Println("nootify-desktop " + version)
		return
	}
	defer func() {
		if failure := recover(); failure != nil {
			reportStartupError(fmt.Sprint(failure))
			os.Exit(1)
		}
	}()
	smoke := slices.Contains(os.Args[1:], "--smoke-test") || slices.Contains(os.Args[1:], "--smoke-reopen")
	identity := appID
	name := "Nootify"
	if smoke {
		identity = "dev.idy.nootify.dev.smoke"
		id := os.Getenv("NOOTIFY_SMOKE_ID")
		if id == "" {
			id = fmt.Sprint(os.Getpid())
			_ = os.Setenv("NOOTIFY_SMOKE_ID", id)
		}
		name = "Nootify Smoke " + service.MenuText(id)
	} else if identity != "dev.idy.nootify" {
		name = "Nootify Development"
	}
	if err := configureNativeIdentity(identity); err != nil {
		reportStartupError(err.Error())
		return
	}
	// A replacement must rendezvous with its live supervisor before initializing
	// native resources or acquiring the instance lock. A stale receipt fails closed.
	guiHandoff, handoffErr := updater.AcceptGUIHandoff(os.Args[1:], version, appID)
	if handoffErr != nil {
		log.Printf("Cannot accept update GUI handoff: %v", handoffErr)
		return
	}
	defer guiHandoff.Stopped()
	mygo.App.SetName(name)
	mygo.App.SetVersion(version)
	config, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	state := filepath.Join(config, identity)
	if smoke {
		state, err = os.MkdirTemp("", "nootify-mygo-smoke-")
		if err != nil {
			log.Fatal(err)
		}
		defer os.RemoveAll(state)
	}
	// Preserve Tauri's app_config_dir exactly, including existing language.json.
	mygo.App.SetPath(mygo.PathUserData, state)
	mygo.App.SetPath(mygo.PathCache, filepath.Join(state, "cache"))
	mygo.App.SetPath(mygo.PathLogs, filepath.Join(state, "logs"))
	if !mygo.App.RequestSingleInstanceLock() {
		guiHandoff.Refuse()
		return
	}
	offline, err := startOffline()
	if err != nil {
		log.Fatal(err)
	}
	defer offline.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startupGate := make(chan struct{})
	s := &shell{ctx: ctx, cancel: cancel, smoke: smoke, offline: offline, policy: urlPolicy{offline: offline.URL, isolated: smoke}, requests: make(chan string, 4), updateRequests: make(chan string, 2), action: language.ServiceKeepsRunning, startupGate: startupGate, guiHandoff: guiHandoff, guiReady: make(chan struct{}), suppressServiceStart: guiHandoff.SuppressServiceStart()}
	if guiHandoff == nil {
		close(startupGate)
	} else {
		go guiHandoff.AwaitCommit(s.guiReady, func() { close(startupGate) }, func() { mygo.App.Quit() })
	}
	if smoke {
		if raw := os.Getenv("NOOTIFY_SMOKE_UI_URL"); raw != "" {
			s.policy.preview = previewURL(raw)
			if s.policy.preview == "" {
				log.Fatal("NOOTIFY_SMOKE_UI_URL must be an explicit 127.0.0.1 HTTP root URL")
			}
		}
	}
	mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) {
		if s.updateShutdown.deferQuit(s.cancel, mygo.App.Quit) {
			e.PreventDefault()
			return
		}
		s.quitting = true
	})
	mygo.App.OnQuit(func() {
		cancel()
		if s.ui != nil {
			s.ui.Close()
		}
		if s.tray != nil {
			s.tray.Destroy()
		}
	})
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.OnSecondInstance(func([]string, string) { s.restore(); s.request("refresh") })
	mygo.App.OnActivate(func(bool) { s.restore(); s.request("refresh") })
	mygo.App.WhenReady(func() {
		path := filepath.Join(state, "language.json")
		if smoke {
			path = ""
		}
		s.language = language.Load(path, systemLocale)
		s.configureLanguage()
		mygo.Theme.SetSource(mygo.ThemeSystem)
		s.update = updater.View{Phase: "idle", Current: version}
		s.createWindow()
		s.createMenus()
		if err := s.createTray(); err != nil {
			log.Printf("Cannot create tray: %v", err)
			mygo.App.Exit(1)
			return
		}
		if smoke {
			go s.runSmoke()
			return
		}
		home, err := os.UserHomeDir()
		if err != nil {
			log.Print(err)
			return
		}
		bundle, bundleErr := service.Current()
		if appID != "dev.idy.nootify" {
			bundle = nil
		}
		s.service = service.New(home, bundle)
		s.serviceHandoff = &serviceHandoff{service: s.service}
		if bundleErr != nil {
			s.actionError = bundleErr
			s.action = language.InstallService
		}
		s.configureUpdater()
		go s.serviceWorker(bundleErr)
		updateDone := make(chan struct{})
		s.updateShutdown.done = updateDone
		go func() {
			installed := s.updateWorker()
			close(updateDone)
			if installed {
				mygo.RunOnMain(func() {
					if s.ctx.Err() != nil {
						return
					}
					s.updateRelaunch = true
					// The macOS updater retains its original until a supervised GUI
					// handshake after this event loop exits. MyGo Relaunch has no result.
					mygo.App.Quit()
				})
			}
		}()
		if appID == "dev.idy.nootify" && bundle != nil {
			go func() {
				if s.awaitStartup() {
					s.updates.Run(ctx)
				}
			}()
		}
		s.guiInitialized = true
		s.confirmGUIReady()
	})
	if err := mygo.App.Run(); err != nil {
		log.Print(err)
	}
	// OnQuit has released the single-instance lock. Keep this process alive as a
	// headless supervisor until the replacement GUI commits or recovery finishes.
	if s.updates != nil && s.updates.PendingGUI() {
		h := s.serviceHandoff
		defer h.releaseGUI()
		if !s.updateRelaunch {
			if err := s.updates.AbortGUI(); err != nil {
				log.Printf("Cancel update GUI handoff: %v", err)
			} else if err := h.after(); err != nil {
				log.Printf("Recover service after cancelled GUI handoff: %v", err)
			}
			return
		}
		if err := s.updates.FinishGUI(context.Background(), updater.GUIRelaunchOptions{SuppressServiceStart: !h.wasRunning, AfterReady: h.after, RecoverOriginal: h.after}); err != nil {
			log.Printf("Update GUI handoff: %v", err)
		}
	}
}
func (s *shell) awaitStartup() bool {
	select {
	case <-s.startupGate:
		return s.ctx.Err() == nil
	case <-s.ctx.Done():
		return false
	}
}
func (s *shell) confirmGUIReady() {
	if s.guiHandoff != nil && s.guiInitialized && s.guiDocumentLoaded && !s.guiSignaled {
		s.guiSignaled = true
		close(s.guiReady)
	}
}
func systemLocale() language.Locale {
	langs := mygo.App.PreferredLanguages()
	if len(langs) > 0 {
		return language.Resolve(langs[0])
	}
	return language.EN
}
func (s *shell) configureLanguage() { mygo.App.SetLanguages(s.language.View().BridgeTag()) }
func (s *shell) preload() string {
	roots := []string{s.policy.offline, s.policy.preview}
	data, _ := json.Marshal(roots)
	titlebar, _ := assets.ReadFile("titlebar.js")
	probe := ""
	if s.smoke {
		probe = "window.__nootifySmokeDocumentLanguage = JSON.stringify(window.__NOOTIFY_LANGUAGE__);"
	}
	platform := "macos"
	if runtime.GOOS == "windows" {
		platform = "windows"
	}
	return `// nootify-language and fixed titlebar bootstrap
(()=>{if(window!==window.top)return;const roots=` + string(data) + `;let trusted=false;try{const here=new URL(location.href);trusted=!here.username&&!here.password&&here.pathname==='/'&&(roots.filter(Boolean).some(root=>{const u=new URL(root);return here.origin===u.origin;})||` + fmt.Sprint(!s.policy.isolated) + `&&here.protocol==='http:'&&here.hostname==='127.0.0.1'&&!!here.port);}catch{}if(!trusted)return;
` + s.language.View().SeedScript() + probe + `
window.__NOOTIFY_PLATFORM__ = '` + platform + `';
` + string(titlebar) + `
})();`
}

// All callers run on the UI thread; child exit revokes its origin even before the next health poll.
func (s *shell) trustedDocument(raw string) bool {
	if !s.policy.allowed(raw) {
		return false
	}
	return s.policy.gateway == "" || !documentAt(raw, s.policy.gateway) || s.ui != nil && s.ui.Alive()
}
func (s *shell) createWindow() {
	session := mygo.DefaultSession()
	if s.smoke {
		session = mygo.NewEphemeralSession()
	}
	opts := mygo.WindowOptions{Title: "Nootify", Width: 1180, Height: 760, MinWidth: 640, MinHeight: 420, BackgroundColor: "light-dark(#f7f8fa, #111113)", Page: mygo.PageOptions{PreloadScript: s.preload(), Untrusted: true, DevTools: mygo.DevToolsDisabled, Session: session}}
	if runtime.GOOS == "darwin" {
		opts.TitleBarStyle = mygo.TitleBarHidden
		opts.TrafficLightPosition = &mygo.Point{X: 16, Y: 20}
	}
	// Install policy before the first LoadURL. A URL in NewWindow would start
	// loading before listeners are attached.
	s.window = mygo.NewWindow(opts)
	page := s.window.Page()
	s.window.OnClose(func(e *mygo.CloseEvent) {
		if !s.quitting {
			e.PreventDefault()
			s.window.Hide()
		}
	})
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	page.OnWillDownload(func(e *mygo.DownloadEvent) {
		if s.trustedDocument(page.URL()) {
			s.policy.download(page.URL(), e)
		} else {
			e.PreventDefault()
		}
	})
	page.OnWillNavigate(func(e *mygo.NavigateEvent) {
		if action := fixedAction(e.URL); action != "" {
			e.PreventDefault()
			if s.trustedDocument(page.URL()) {
				s.handle(action, true)
			}
			return
		}
		if externalURL(e.URL) {
			e.PreventDefault()
			if s.trustedDocument(page.URL()) {
				go func() {
					if err := mygo.Shell.OpenExternal(e.URL); err != nil {
						log.Print(err)
					}
				}()
			}
			return
		}
		if !s.trustedDocument(e.URL) {
			e.PreventDefault()
		}
	})
	page.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
		if s.trustedDocument(page.URL()) && externalURL(req.URL) {
			go func() { _ = mygo.Shell.OpenExternal(req.URL) }()
		}
		return nil
	})
	page.OnDidFinishLoad(func() {
		s.noteSmokeLoad("finished", 0)
		if documentAt(page.URL(), s.offline.URL) {
			s.guiDocumentLoaded = true
			s.confirmGUIReady()
		}
		s.finish(s.ui != nil && s.ui.Alive() && documentAt(page.URL(), s.policy.gateway))
		if s.trustedDocument(page.URL()) {
			s.publish()
		}
	})
	page.OnDidNavigate(func(raw string) {
		s.noteSmokeLoad("navigated", 0)
		if !s.trustedDocument(raw) {
			s.noteSmokeLoad("blocked", 0)
			log.Print("Blocked unexpected document")
			s.online = false
			s.loading = false
			_ = page.LoadURL(s.offline.URL)
		}
	})
	page.OnDidFailLoad(func(failure *mygo.LoadError) {
		code := 0
		if failure != nil {
			code = failure.Code
		}
		s.noteSmokeLoad("failed", code)
		s.online = false
		s.loading = false
		if s.ctx.Err() == nil && !documentAt(page.URL(), s.offline.URL) {
			_ = page.LoadURL(s.offline.URL)
		}
	})
	page.OnRenderProcessGone(func(string) {
		s.noteSmokeLoad("renderer_gone", 0)
		s.online = false
		s.loading = false
		_ = page.LoadURL(s.offline.URL)
	})
	_ = page.LoadURL(s.offline.URL)
}
func (s *shell) restore() {
	if s.window != nil {
		mygo.App.Show()
		s.window.Restore()
		s.window.Show()
		s.window.Focus()
	}
}
func (s *shell) eval(source string) {
	if s.window == nil || !s.trustedDocument(s.window.Page().URL()) {
		return
	}
	page := s.window.Page()
	s.evaluations.submit(s.ctx, source, func(ctx context.Context, source string) {
		// Navigation may have occurred while this snapshot waited for an earlier
		// evaluation. Reapply the origin policy at execution time as well.
		trusted := false
		mygo.RunOnMain(func() { trusted = s.trustedDocument(page.URL()) })
		if trusted {
			_, _ = page.EvalContext(ctx, source)
		}
	})
}
func (s *shell) publish() { s.eval(s.language.View().Script() + updateScript(s.update)) }
func updateScript(view updater.View) string {
	data, _ := json.Marshal(view)
	return "window.dispatchEvent(new CustomEvent('nootify-update', {detail:" + string(data) + "}));"
}
func (s *shell) changeLanguage(p language.Preference) {
	if _, err := s.language.Set(p); err != nil {
		log.Printf("Cannot save app language: %v", err)
		return
	}
	s.configureLanguage()
	s.publish()
	s.relocalize()
}
func (s *shell) openSettings(about bool) {
	s.restore()
	fragment := "#/settings/general"
	if about {
		fragment = "#/settings/about"
	}
	s.eval("location.hash = '" + fragment + "'")
	s.request("refresh")
}
func (s *shell) handle(action string, fromPage bool) {
	switch {
	case strings.HasPrefix(action, "language_"):
		s.changeLanguage(language.Preference(strings.TrimPrefix(action, "language_")))
	case action == "drag":
		startWindowDrag(s.window)
	case action == "zoom":
		if s.window.IsMaximized() {
			s.window.Unmaximize()
		} else {
			s.window.Maximize()
		}
	case action == "open":
		s.restore()
		s.request("refresh")
	case action == "settings":
		s.openSettings(false)
	case action == "about":
		s.openSettings(true)
	case action == "quit":
		mygo.App.Quit()
	case action == "check_update" || action == "install_update":
		if fromPage {
			s.pageRequests.Add(1)
		}
		if !s.smoke {
			select {
			case s.updateRequests <- action:
			default:
			}
		}
	default:
		s.request(action)
	}
}
func (s *shell) request(action string) {
	if s.smoke {
		return
	}
	if action != "refresh" {
		if s.actionPending {
			return
		}
		s.actionPending = true
		s.renderHealth()
	}
	select {
	case s.requests <- action:
	default:
		s.actionPending = false
	}
}
func (s *shell) setServiceView(online bool, ownerURL string) {
	if online {
		if !s.begin() {
			return
		}
		if err := s.window.Page().LoadURL(ownerURL); err != nil {
			s.failed()
		}
		return
	}
	s.online = false
	s.loading = false
	if !documentAt(s.window.Page().URL(), s.offline.URL) {
		_ = s.window.Page().LoadURL(s.offline.URL)
	}
}
func (s *shell) serviceWorker(bundleErr error) {
	if !s.awaitStartup() {
		return
	}
	client := service.HealthClient()
	legacyRestarted := false
	poll := func() {
		h, err := service.CheckHealth(s.ctx, client, service.URL)
		installed, inspectErr := s.service.Installed(s.ctx)
		// Old independent daemons can outlive a manual app replacement. Health is
		// advisory only: the bundled CLI still proves exact ownership before restart.
		if !s.suppressServiceStart && err == nil && h.UITransport == 0 && installed && inspectErr == nil && s.service.Bundle != nil && !legacyRestarted {
			legacyRestarted = true
			s.runServiceAction("restart")
			h, err = service.CheckHealth(s.ctx, client, service.URL)
		}
		var owned *service.OwnedUI
		currentRoute := "#/logs"
		mygo.RunOnMain(func() {
			if s.ui != nil && !s.ui.Alive() {
				s.policy.gateway = ""
				s.ui = nil
				s.setServiceView(false, "")
			}
			owned = s.ui
			if _, fragment, found := strings.Cut(s.window.Page().URL(), "#"); found && !strings.Contains(fragment, "nootify-ui=") {
				currentRoute = "#" + fragment
			}
		})
		if owned == nil && err == nil {
			owned, err = s.service.OpenUI(s.ctx, currentRoute)
		}
		ownerURL := ""
		if owned != nil && owned.Alive() {
			ownerURL = owned.URL
		}
		mygo.RunOnMain(func() {
			if s.ctx.Err() != nil {
				return
			}
			s.installed = installed
			if inspectErr != nil {
				log.Printf("Cannot inspect background service: %v", inspectErr)
			}
			s.health = nil
			if err == nil {
				s.health = &h
			}
			s.healthError = err
			if s.language.RefreshSystem() {
				s.configureLanguage()
				s.publish()
				s.relocalize()
			}
			s.renderHealth()
			if owned != nil && owned.Alive() {
				s.ui = owned
				s.policy.gateway = owned.Origin()
				s.setServiceView(true, ownerURL)
			} else {
				s.policy.gateway = ""
				s.setServiceView(false, "")
			}
		})
	}
	if _, err := service.CheckHealth(s.ctx, client, service.URL); !s.suppressServiceStart && err != nil && bundleErr == nil && s.service.Bundle != nil {
		installed, inspectErr := s.service.Installed(s.ctx)
		if inspectErr == nil {
			if action := initialServiceAction(s.suppressServiceStart, false, installed); action != "" {
				s.runServiceAction(action)
			}
		}
	}
	poll()
	timer := time.NewTicker(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case action := <-s.requests:
			if action == "authorize_ui" {
				// Fixed native reauthorization follows the same worker-only CLI grant
				// path as first load. No page-provided URLs or bearer tokens cross it.
				var retired *service.OwnedUI
				mygo.RunOnMain(func() {
					retired = s.ui
					s.ui = nil
					s.policy.gateway = ""
					s.actionPending = false
					s.setServiceView(false, "")
				})
				if retired != nil {
					retired.Close()
				}
			} else if action != "refresh" {
				s.runServiceAction(action)
			}
			poll()
		case <-timer.C:
			poll()
		}
	}
}
func (s *shell) runServiceAction(action string) {
	progress, label, complete := language.StartingService, language.StartService, language.StartRequested
	if action == "restart" {
		progress, label, complete = language.RestartingService, language.RestartService, language.RestartRequested
	}
	if action == "install_service" {
		progress, label, complete = language.InstallingService, language.InstallService, language.Installed
	}
	mygo.RunOnMain(func() { s.actionPending = true; s.action = progress; s.actionError = nil; s.renderHealth() })
	err := s.serviceHandoff.action(s.ctx, action)
	mygo.RunOnMain(func() {
		s.actionPending = false
		s.action = complete
		s.actionError = err
		if err != nil {
			s.action = label
		}
		s.renderHealth()
	})
}
func (s *shell) configureUpdater() {
	exe, _ := os.Executable()
	exe, _ = filepath.EvalSymlinks(exe)
	platform := "darwin-aarch64"
	if runtime.GOOS == "windows" {
		platform = "windows-x86_64-nsis"
		if err := updater.CleanupInstallers(); err != nil {
			log.Printf("Clean up completed update installers: %v", err)
		}
	}
	s.updates = updater.New(updater.Options{Version: version, ManifestURL: updater.DefaultManifestURL, PublicKey: updater.DefaultPublicKey, Platform: platform, Executable: exe,
		BeforeInstall: func(ctx context.Context) error {
			if s.service.Bundle == nil {
				return errors.New("development builds cannot install updates")
			}
			if runtime.GOOS == "windows" {
				return nil
			}
			return s.serviceHandoff.before(ctx)
		},
		// macOS service restoration follows confirmed GUI readiness in FinishGUI.
		AfterInstall: func() error {
			if runtime.GOOS == "windows" {
				return s.serviceHandoff.after()
			}
			return nil
		}, BeforeRollback: s.serviceHandoff.beforeRollback, ConfirmGUI: runtime.GOOS == "darwin"})
	s.update = s.updates.View()
	s.updates.SetListener(func(v updater.View) {
		mygo.RunOnMain(func() {
			if s.ctx.Err() != nil {
				return
			}
			s.update = v
			s.renderUpdate()
			s.eval(updateScript(v))
		})
	})
}
func (s *shell) updateWorker() bool {
	if !s.awaitStartup() {
		return false
	}
	return runUpdateRequests(s.ctx, s.updateRequests, s.updates.Check,
		func(ctx context.Context) error {
			return s.serviceHandoff.install(ctx, func(ctx context.Context) error {
				err := s.updates.Install(ctx)
				if err == nil && s.updates.PendingGUI() {
					if ctx.Err() != nil {
						rollbackErr := s.updates.AbortGUI()
						if rollbackErr != nil {
							s.serviceHandoff.recoveryBlocked = true
						}
						return errors.Join(ctx.Err(), rollbackErr)
					}
					s.serviceHandoff.guiPending = true
				}
				return err
			})
		},
		func(err error) { log.Printf("Update: %v", err) })
}
