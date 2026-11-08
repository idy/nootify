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
	ctx              context.Context
	cancel           context.CancelFunc
	smoke            bool
	offline          *offlineServer
	policy           urlPolicy
	window           *mygo.Window
	tray             *mygo.Tray
	menu             *mygo.Menu
	nativeMenu       *mygo.Menu
	language         *language.Store
	service          *service.Manager
	updates          *updater.Manager
	update           updater.View
	requests         chan string
	updateRequests   chan string
	pageRequests     atomic.Uint64
	quitting         bool
	online           bool
	health           *service.Health
	healthError      error
	installed        bool
	actionPending    bool
	action           language.Text
	actionError      error
	moduleLabels     []string
	stoppedForUpdate atomic.Bool
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
		return
	}
	offline, err := startOffline()
	if err != nil {
		log.Fatal(err)
	}
	defer offline.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &shell{ctx: ctx, cancel: cancel, smoke: smoke, offline: offline, policy: urlPolicy{offline: offline.URL, isolated: smoke}, requests: make(chan string, 4), updateRequests: make(chan string, 2), action: language.ServiceKeepsRunning}
	if smoke {
		if raw := os.Getenv("NOOTIFY_SMOKE_UI_URL"); raw != "" {
			s.policy.preview = previewURL(raw)
			if s.policy.preview == "" {
				log.Fatal("NOOTIFY_SMOKE_UI_URL must be an explicit 127.0.0.1 HTTP root URL")
			}
		}
	}
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { s.quitting = true })
	mygo.App.OnQuit(func() {
		cancel()
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
		if bundleErr != nil {
			s.actionError = bundleErr
			s.action = language.InstallService
		}
		s.configureUpdater()
		go s.serviceWorker(bundleErr)
		go s.updateWorker()
		if appID == "dev.idy.nootify" && bundle != nil {
			go s.updates.Run(ctx)
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
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
	if !s.policy.isolated {
		roots = append(roots, service.URL)
	}
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
(()=>{if(window!==window.top)return;const roots=` + string(data) + `;let trusted=false;try{const here=new URL(location.href);trusted=!here.username&&!here.password&&here.pathname==='/'&&roots.filter(Boolean).some(root=>{const u=new URL(root);return here.origin===u.origin;});}catch{}if(!trusted)return;
` + s.language.View().SeedScript() + probe + `
window.__NOOTIFY_PLATFORM__ = '` + platform + `';
` + string(titlebar) + `
})();`
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
	page.OnWillDownload(func(e *mygo.DownloadEvent) { e.PreventDefault() })
	page.OnWillNavigate(func(e *mygo.NavigateEvent) {
		if action := fixedAction(e.URL); action != "" {
			e.PreventDefault()
			if s.policy.allowed(page.URL()) {
				s.handle(action, true)
			}
			return
		}
		if externalURL(e.URL) {
			e.PreventDefault()
			if s.policy.allowed(page.URL()) {
				go func() {
					if err := mygo.Shell.OpenExternal(e.URL); err != nil {
						log.Print(err)
					}
				}()
			}
			return
		}
		if !s.policy.allowed(e.URL) {
			e.PreventDefault()
		}
	})
	page.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
		if s.policy.allowed(page.URL()) && externalURL(req.URL) {
			go func() { _ = mygo.Shell.OpenExternal(req.URL) }()
		}
		return nil
	})
	page.OnDidFinishLoad(func() {
		if s.policy.allowed(page.URL()) {
			s.publish()
		}
	})
	page.OnDidNavigate(func(raw string) {
		if !s.policy.allowed(raw) {
			log.Printf("Blocked unexpected document: %s", raw)
			_ = page.LoadURL(s.offline.URL)
		}
	})
	page.OnRenderProcessGone(func(string) { _ = page.LoadURL(s.offline.URL); s.online = false })
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
	if s.window == nil || !s.policy.allowed(s.window.Page().URL()) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
		defer cancel()
		_, _ = s.window.Page().EvalContext(ctx, source)
	}()
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
func (s *shell) setServiceView(online bool) {
	if s.online == online {
		return
	}
	s.online = online
	target := s.offline.URL
	if online {
		target = service.URL
	}
	_ = s.window.Page().LoadURL(target)
}
func (s *shell) serviceWorker(bundleErr error) {
	client := service.HealthClient()
	poll := func() {
		h, err := service.CheckHealth(s.ctx, client, service.URL)
		installed, inspectErr := s.service.Installed(s.ctx)
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
			s.setServiceView(err == nil)
		})
	}
	if _, err := service.CheckHealth(s.ctx, client, service.URL); err != nil && bundleErr == nil && s.service.Bundle != nil {
		installed, inspectErr := s.service.Installed(s.ctx)
		if inspectErr == nil {
			action := "install_service"
			if installed {
				action = "start"
			}
			s.runServiceAction(action)
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
			if action != "refresh" {
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
	var err error
	if action == "install_service" {
		err = s.service.Install(s.ctx)
	} else {
		err = s.service.Request(s.ctx, action)
	}
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
	}
	s.updates = updater.New(updater.Options{Version: version, ManifestURL: updater.DefaultManifestURL, PublicKey: updater.DefaultPublicKey, Platform: platform, Executable: exe,
		BeforeInstall: func(ctx context.Context) error {
			if s.service.Bundle == nil {
				return errors.New("development builds cannot install updates")
			}
			if runtime.GOOS == "windows" {
				return nil
			}
			stopped, err := s.service.StopForUpdate(ctx)
			s.stoppedForUpdate.Store(stopped)
			return err
		},
		AfterInstall: func() error {
			if runtime.GOOS == "darwin" && s.stoppedForUpdate.Load() {
				ctx, cancel := context.WithTimeout(context.Background(), 155*time.Second)
				defer cancel()
				if err := s.service.Request(ctx, "start"); err != nil {
					return err
				}
			}
			mygo.RunOnMain(func() {
				if runtime.GOOS == "darwin" {
					mygo.App.Relaunch()
				}
				mygo.App.Quit()
			})
			return nil
		}})
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
func (s *shell) updateWorker() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case action := <-s.updateRequests:
			var err error
			if action == "check_update" {
				err = s.updates.Check(s.ctx)
			} else {
				err = s.updates.Install(s.ctx)
			}
			if err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("Update: %v", err)
				if runtime.GOOS == "darwin" && s.stoppedForUpdate.Swap(false) {
					if restartErr := s.service.Request(s.ctx, "start"); restartErr != nil {
						log.Printf("Cannot recover background service after update: %v", restartErr)
					}
				}
			}
		}
	}
}
