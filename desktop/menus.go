package main

import (
	"fmt"
	"log"
	"runtime"
	"slices"

	"github.com/egoist/mygo"
	"github.com/idy/nootify/desktop/internal/language"
	"github.com/idy/nootify/desktop/internal/service"
)

func (s *shell) item(id string, key language.Text) *mygo.MenuItem {
	return &mygo.MenuItem{ID: id, Label: s.language.View().Locale.Text(key), Click: func(*mygo.MenuItem, *mygo.Window) { s.handle(id, false) }}
}
func (s *shell) trayMenu(labels []string) *mygo.Menu {
	l := s.language.View().Locale
	modules := make([]*mygo.MenuItem, 0, len(labels))
	for i, label := range labels {
		modules = append(modules, &mygo.MenuItem{ID: fmt.Sprintf("module-%d", i), Label: label, Disabled: true})
	}
	settings := s.item("settings", language.Settings)
	settings.Accelerator = "CmdOrCtrl+,"
	quit := s.item("quit", language.Quit)
	quit.Accelerator = "CmdOrCtrl+Q"
	install := s.item("install_update", language.InstallUpdate)
	install.Hidden = true
	return mygo.NewMenu([]*mygo.MenuItem{
		s.item("open", language.Open), mygo.Separator(), {ID: "status", Label: l.Text(language.CheckingHealth), Disabled: true}, install,
		{ID: "service", Label: l.Text(language.BackgroundService), Submenu: []*mygo.MenuItem{
			{ID: "modules", Label: l.Text(language.Modules), Submenu: modules}, s.item("refresh", language.Refresh), mygo.Separator(), s.item("start", language.RetryStart), s.item("restart", language.Restart), s.item("install_service", language.InstallService), mygo.Separator(), {ID: "action", Label: l.Text(language.ServiceKeepsRunning), Disabled: true},
		}},
		{ID: "updates", Label: l.Text(language.SoftwareUpdates), Submenu: []*mygo.MenuItem{{ID: "update_status", Disabled: true}, s.item("check_update", language.CheckUpdate), s.item("about", language.UpdateDetails)}},
		settings, mygo.Separator(), quit,
	})
}
func (s *shell) createMenus() {
	s.moduleLabels = []string{s.language.View().Locale.Text(language.CheckingModules)}
	s.menu = s.trayMenu(s.moduleLabels)
	s.createAppMenu()
	s.renderHealth()
	s.renderUpdate()
}
func (s *shell) createTray() error {
	path := "icons/tray-template.png"
	if runtime.GOOS == "windows" {
		path = "icons/32x32.png"
	}
	icon, err := assets.ReadFile(path)
	if err != nil {
		return err
	}
	s.tray, err = mygo.NewTray(mygo.TrayOptions{ID: appID, Icon: icon, IconIsTemplate: runtime.GOOS == "darwin", ToolTip: "Nootify", Menu: s.menu})
	return err
}
func (s *shell) createAppMenu() {
	if runtime.GOOS != "darwin" {
		return
	}
	l := s.language.View().Locale
	role := func(r mygo.MenuRole, t language.Text) *mygo.MenuItem {
		return &mygo.MenuItem{Role: r, Label: l.Text(t)}
	}
	s.nativeMenu = mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Nootify", Submenu: []*mygo.MenuItem{role(mygo.RoleAbout, language.About), mygo.Separator(), role(mygo.RoleServices, language.Services), mygo.Separator(), role(mygo.RoleHide, language.Hide), role(mygo.RoleHideOthers, language.HideOthers), mygo.Separator(), role(mygo.RoleQuit, language.Quit)}},
		{Label: l.Text(language.File), Submenu: []*mygo.MenuItem{role(mygo.RoleClose, language.CloseWindow)}},
		{Label: l.Text(language.Edit), Submenu: []*mygo.MenuItem{role(mygo.RoleUndo, language.Undo), role(mygo.RoleRedo, language.Redo), mygo.Separator(), role(mygo.RoleCut, language.Cut), role(mygo.RoleCopy, language.Copy), role(mygo.RolePaste, language.Paste), role(mygo.RoleSelectAll, language.SelectAll)}},
		{Label: l.Text(language.ViewMenu), Submenu: []*mygo.MenuItem{role(mygo.RoleToggleFullScreen, language.Fullscreen)}},
		{Label: l.Text(language.Window), Role: mygo.RoleWindow, Submenu: []*mygo.MenuItem{role(mygo.RoleMinimize, language.Minimize), role(mygo.RoleZoom, language.Zoom), mygo.Separator(), role(mygo.RoleClose, language.CloseWindow)}},
		{Label: l.Text(language.Help), Role: mygo.RoleHelp, Submenu: []*mygo.MenuItem{}},
	})
	mygo.App.SetMenu(s.nativeMenu)
}
func (s *shell) relocalize() {
	s.createAppMenu()
	s.moduleLabels = nil
	s.renderHealth()
	for id, key := range map[string]language.Text{"open": language.Open, "refresh": language.Refresh, "start": language.RetryStart, "restart": language.Restart, "install_service": language.InstallService, "settings": language.Settings, "quit": language.Quit, "service": language.BackgroundService, "modules": language.Modules, "updates": language.SoftwareUpdates, "check_update": language.CheckUpdate, "about": language.UpdateDetails} {
		s.menu.ItemByID(id).SetLabel(s.language.View().Locale.Text(key))
	}
	s.renderUpdate()
}
func moduleLabel(l language.Locale, name, status string) string {
	names := map[string]language.Text{"sessions": language.Sessions, "lark": language.Lark, "pulls": language.Pulls, "agents": language.Agents}
	states := map[string]language.Text{"ready": language.Ready, "disabled": language.Disabled, "connecting": language.Connecting, "reconnecting": language.Reconnecting, "failed": language.Failed, "stopped": language.Stopped, "refreshing": language.Refreshing, "signed_out": language.SignedOut, "stale": language.Stale, "error": language.Error, "idle": language.Idle}
	if key, ok := names[name]; ok {
		name = l.Text(key)
	}
	if key, ok := states[status]; ok {
		status = l.Text(key)
	}
	return service.MenuText(l.Format(language.ModuleStatus, map[string]string{"name": name, "status": status}))
}
func (s *shell) renderHealth() {
	if s.menu == nil {
		return
	}
	l := s.language.View().Locale
	status := l.Text(language.CheckingHealth)
	labels := []string{l.Text(language.CheckingModules)}
	if s.health != nil {
		status = l.Text(language.Running)
		labels = nil
		for _, m := range s.health.Modules {
			labels = append(labels, moduleLabel(l, m.Name, m.Status))
		}
	} else if s.healthError != nil {
		status = l.Text(language.Offline)
		labels = []string{service.MenuText(s.healthError.Error())}
	}
	if !slices.Equal(labels, s.moduleLabels) {
		s.moduleLabels = labels
		s.menu = s.trayMenu(labels)
		if s.tray != nil {
			s.tray.SetMenu(s.menu)
		}
		s.renderUpdate()
	}
	s.menu.ItemByID("status").SetLabel(status)
	s.menu.ItemByID("start").SetEnabled(s.health == nil && !s.actionPending && s.service != nil && s.service.Bundle != nil)
	s.menu.ItemByID("restart").SetEnabled(!s.actionPending && s.service != nil && s.service.Bundle != nil)
	s.menu.ItemByID("install_service").SetEnabled(!s.installed && !s.actionPending && s.service != nil && s.service.Bundle != nil)
	s.menu.ItemByID("settings").SetEnabled(s.health != nil)
	s.menu.ItemByID("about").SetEnabled(s.health != nil)
	text := l.Text(s.action)
	if s.actionError != nil {
		text = l.Format(language.ActionFailed, map[string]string{"action": text, "error": s.actionError.Error()})
	}
	s.menu.ItemByID("action").SetLabel(service.MenuText(text))
	if s.tray != nil {
		detail := slices.Clone(labels)
		s.tray.SetToolTip(status + "\n" + service.MenuText(fmt.Sprint(detail)))
	}
}
func (s *shell) renderUpdate() {
	if s.menu == nil {
		return
	}
	l := s.language.View().Locale
	v := s.update
	tag := func(v string) string {
		if v != "" && v[0] != 'v' {
			return "v" + v
		}
		return v
	}
	text := l.Format(language.CurrentVersion, map[string]string{"version": tag(v.Current)})
	busy := v.Phase == "checking" || v.Phase == "downloading" || v.Phase == "installing" || v.Phase == "restarting"
	shown := v.Version != nil && (v.Phase == "available" || v.Phase == "downloading" || v.Phase == "installing" || v.Phase == "install_error" || v.Phase == "restarting")
	installText := l.Text(language.InstallUpdate)
	if v.Version != nil {
		installText = l.Format(language.InstallVersion, map[string]string{"version": tag(*v.Version)})
	}
	switch v.Phase {
	case "checking":
		text = l.Text(language.CheckingUpdate)
	case "available":
		text = l.Format(language.UpdateAvailable, map[string]string{"version": tag(value(v.Version))})
		if v.Error != nil {
			text = l.Text(language.InstallFailed)
		}
	case "current":
		text = l.Format(language.UpToDate, map[string]string{"version": tag(v.Current)})
	case "failed", "check_error":
		text = l.Text(language.CheckFailed)
	case "downloading":
		text = l.Text(language.Downloading)
		if v.Total != nil && *v.Total > 0 {
			percent := min(uint64(100), uint64(float64(v.Received)/float64(*v.Total)*100))
			text = l.Format(language.DownloadPercent, map[string]string{"percent": fmt.Sprint(percent)})
		}
		installText = text
	case "installing":
		text = l.Text(language.Installing)
		installText = text
	case "install_error":
		text = l.Text(language.InstallFailed)
	case "restarting":
		text = l.Text(language.Restarting)
		installText = text
	}
	s.menu.ItemByID("update_status").SetLabel(text)
	s.menu.ItemByID("check_update").SetEnabled(!busy)
	it := s.menu.ItemByID("install_update")
	it.SetVisible(shown)
	it.SetLabel(installText)
	it.SetEnabled(shown && !busy)
}
func value(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func reportStartupError(message string) { log.Print(message); nativeStartupError(message) }
