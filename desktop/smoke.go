package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"github.com/egoist/mygo"
	"github.com/idy/nootify/desktop/internal/language"
	"github.com/idy/nootify/desktop/internal/updater"
)

// Smoke never starts service or update workers, queries production health, reads
// production credentials, or persists app preferences. Its second process uses
// the same isolated name, never the installed desktop's single-instance lock.
func (s *shell) runSmoke() {
	report := map[string]any{"platform": runtime.GOOS, "daemon_control_invoked": false, "service_install_invoked": false, "update_install_invoked": false, "language_smoke_persistence_isolated": true}
	err := s.exerciseSmoke(report)
	if err == nil {
		if path := os.Getenv("NOOTIFY_SMOKE_SCREENSHOT"); path != "" {
			var image []byte
			image, err = s.window.CapturePage()
			if err == nil {
				err = os.WriteFile(path, image, 0600)
				report["screenshot"] = path
			}
		}
		if hold, _ := strconv.Atoi(os.Getenv("NOOTIFY_SMOKE_HOLD_MS")); hold > 0 {
			fmt.Printf("{\"capture\":\"native-ready\",\"window_handle\":%d,\"pid\":%d}\n", s.window.NativeHandle(), os.Getpid())
			time.Sleep(time.Duration(min(hold, 30000)) * time.Millisecond)
		}
	}
	report["ok"] = err == nil
	if err != nil {
		report["error"] = err.Error()
	}
	data, _ := json.Marshal(report)
	fmt.Println(string(data))
	if err != nil {
		mygo.App.Exit(1)
		return
	}
	mygo.App.Quit()
}
func smokeWait(description string, predicate func() bool) error {
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return nil
		}
		time.Sleep(80 * time.Millisecond)
	}
	return fmt.Errorf("timed out: %s", description)
}
func (s *shell) smokeEval(expression string) bool {
	ctx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
	defer cancel()
	v, err := s.window.Page().EvalContext(ctx, expression)
	return err == nil && v == true
}
func (s *shell) exerciseSmoke(report map[string]any) error {
	started := time.Now()
	observations := map[string]int{}
	if err := smokeWait("bundled offline document and icon", func() bool {
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
		defer cancel()
		value, err := s.window.Page().EvalContext(ctx, "!!document.querySelector('h1') && document.querySelector('.mark')?.naturalWidth > 0 && window.__NOOTIFY_LANGUAGE__?.locale === document.documentElement.lang")
		category := smokeEvalCategory(err)
		if err == nil {
			if value == true {
				category = "true"
			} else {
				category = "false"
			}
		}
		observations[category]++
		return err == nil && value == true
	}); err != nil {
		report["startup_eval"] = observations
		report["startup_elapsed_ms"] = time.Since(started).Milliseconds()
		report["startup_load"] = s.smokeLoadSnapshot()
		// Failure-only diagnostics share a separate bounded budget. The original
		// assertion, eight-second wait and two-second eval limits are unchanged.
		ctx, cancel := context.WithTimeout(s.ctx, 1500*time.Millisecond)
		defer cancel()
		for key, value := range collectSmokeStartup(ctx, smokeStartupHooks{
			dispatch: mygo.RunOnMain, inspect: s.smokeNativeSnapshot,
			document: func(ctx context.Context) (any, error) { return s.window.Page().EvalContext(ctx, smokeDocumentSnapshot) },
			assets:   func(ctx context.Context) map[string]any { return smokeAssetStatuses(ctx, s.offline.URL) },
		}) {
			report[key] = value
		}
		return err
	}
	report["bundled_fallback"] = true
	if err := smokeWait("native tray bounds", func() bool { return s.tray.Bounds().Width > 0 }); err != nil {
		return err
	}
	report["tray_present"] = true
	s.window.Close()
	if err := smokeWait("close hides without destroying", func() bool { return !s.window.IsVisible() && !s.window.IsDestroyed() }); err != nil {
		return err
	}
	report["close_hides_without_destroying"] = true
	mygo.RunOnMain(s.restore)
	if err := smokeWait("restore shows and focuses", func() bool { return s.window.IsVisible() && s.window.IsFocused() }); err != nil {
		return err
	}
	report["restore_visible_and_focused"] = true
	s.window.Close()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	exe, _ := os.Executable()
	second := exec.CommandContext(ctx, exe, "--smoke-reopen")
	if output, err := second.CombinedOutput(); err != nil {
		return fmt.Errorf("single-instance second process: %w: %s", err, output)
	}
	if err := smokeWait("second launch restores window", func() bool { return s.window.IsVisible() && s.window.IsFocused() }); err != nil {
		return err
	}
	report["single_instance_restores_window"] = true
	if err := s.smokeSecurity(); err != nil {
		return err
	}
	report["fallback_ipc_denied"] = true
	for _, p := range []language.Preference{language.English, language.System, language.Chinese} {
		if _, err := s.window.Page().Eval("location.href = 'nootify://language/" + string(p) + "'"); err != nil {
			return err
		}
		expected := language.NewView(p, systemLocale())
		data, _ := json.Marshal(expected)
		if err := smokeWait("language bridge", func() bool {
			return s.smokeEval("JSON.stringify(window.__NOOTIFY_LANGUAGE__) === JSON.stringify(" + string(data) + ") && document.documentElement.lang === window.__NOOTIFY_LANGUAGE__.locale")
		}); err != nil {
			return err
		}
	}
	s.window.Page().Reload()
	if err := smokeWait("language at document start after reload", func() bool {
		return s.smokeEval("window.__nootifySmokeDocumentLanguage === JSON.stringify({preference:'zh-CN',locale:'zh-CN'}) && document.querySelector('h1')?.textContent === '正在等待本机服务'")
	}); err != nil {
		return err
	}
	report["language_bridge_and_reload"] = true
	if err := s.smokeUpdate(); err != nil {
		return err
	}
	report["page_update_bridge"] = true
	report["update_menu_rendered"] = true
	report["tray_inline_update_progress"] = true
	if s.policy.preview != "" {
		if err := s.window.Page().LoadURL(s.policy.preview); err != nil {
			return err
		}
		if err := smokeWait("isolated preview desktop titlebar", func() bool {
			return s.smokeEval("document.documentElement.hasAttribute('data-nootify-desktop') && !!document.querySelector('.titlebar #update-action')")
		}); err != nil {
			return err
		}
		if err := s.smokeSecurity(); err != nil {
			return err
		}
		report["remote_ipc_denied"] = true
		if err := s.smokeUpdate(); err != nil {
			return err
		}
		mygo.RunOnMain(func() { s.openSettings(false) })
		if err := smokeWait("settings navigation", func() bool { return s.smokeEval("location.hash === '#/settings/general'") }); err != nil {
			return err
		}
		report["tray_settings_navigation"] = true
		mygo.RunOnMain(func() { s.openSettings(true) })
		if err := smokeWait("about navigation", func() bool { return s.smokeEval("location.hash === '#/settings/about'") }); err != nil {
			return err
		}
		// Exercise the actual titlebar handler, which routes the exact zoom URL.
		if _, err := s.window.Page().Eval("document.querySelector('.titlebar').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,detail:2}))"); err != nil {
			return err
		}
		if err := smokeWait("titlebar native zoom", s.window.IsMaximized); err != nil {
			return err
		}
		s.window.Unmaximize()
		report["titlebar_preview"] = true
	}
	return nil
}
func (s *shell) smokeSecurity() error {
	if !s.smokeEval("window.mygo.call('mygo:window.Close').then(()=>false,()=>true)") {
		return fmt.Errorf("untrusted page received native IPC permission")
	}
	before := s.pageRequests.Load()
	_, _ = s.window.Page().Eval("location.href = 'nootify://update/check?untrusted=1'")
	time.Sleep(100 * time.Millisecond)
	if s.pageRequests.Load() != before {
		return fmt.Errorf("non-exact native request was accepted")
	}
	_, _ = s.window.Page().Eval("location.href = 'https://example.invalid/untrusted'")
	return smokeWait("untrusted navigation canceled", func() bool { return s.smokeEval("!!window.__NOOTIFY_LANGUAGE__ && location.hostname === '127.0.0.1'") })
}
func (s *shell) smokeUpdate() error {
	_, _ = s.window.Page().Eval("window.__nootifySmokeUpdate=null;window.addEventListener('nootify-update',e=>window.__nootifySmokeUpdate=e.detail.phase)")
	version := "0.0.0-smoke"
	total := uint64(100)
	mygo.RunOnMain(func() {
		s.update = updater.View{Phase: "available", Current: version, Version: &version}
		s.renderUpdate()
		s.publish()
	})
	if err := smokeWait("update DOM event delivered", func() bool { return s.smokeEval("window.__nootifySmokeUpdate === 'available'") }); err != nil {
		return err
	}
	before := s.pageRequests.Load()
	_, _ = s.window.Page().Eval("(() => { const button = document.querySelector('.titlebar #update-action'); if (button) button.click(); else location.href='nootify://update/check'; })()")
	if err := smokeWait("fixed update request canceled and received", func() bool {
		return s.pageRequests.Load() > before && s.smokeEval("window.__nootifySmokeUpdate === 'available'")
	}); err != nil {
		return err
	}
	var menuErr error
	mygo.RunOnMain(func() {
		it := s.menu.ItemByID("install_update")
		if !it.IsVisible() || !it.IsEnabled() {
			menuErr = fmt.Errorf("available update missing from tray")
		}
		s.update.Phase = "downloading"
		s.update.Received = 42
		s.update.Total = &total
		s.renderUpdate()
		s.publish()
		if !it.IsVisible() || it.IsEnabled() || s.menu.ItemByID("check_update").IsEnabled() {
			menuErr = fmt.Errorf("downloading tray permits duplicate actions")
		}
	})
	if menuErr != nil {
		return menuErr
	}
	if err := smokeWait("update download event", func() bool { return s.smokeEval("window.__nootifySmokeUpdate === 'downloading'") }); err != nil {
		return err
	}
	mygo.RunOnMain(func() { s.update = updater.View{Phase: "current", Current: version}; s.renderUpdate(); s.publish() })
	return nil
}
