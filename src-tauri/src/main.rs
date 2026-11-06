#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "macos"))]
compile_error!("Nootify currently supports macOS only");

mod app_menu;
mod language;
mod service;
mod smoke;
mod update;

use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::Duration,
};

use language::{LanguageStore, LanguageView, Locale, Preference, Text};
use service::{
    check_health, health_client, menu_text, BundledService, Health, JobAction, LaunchAgent,
    SERVICE_URL,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use update::{UpdateMenu, UpdateRequest, UpdateView};

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "nootify";
const FALLBACK_URL: &str = "tauri://localhost/index.html";
const POLL_INTERVAL: Duration = Duration::from_secs(3);

enum Request {
    Refresh,
    Job(JobAction),
    Install,
}

struct NativeState {
    requests: SyncSender<Request>,
    updates: SyncSender<UpdateRequest>,
    action_pending: AtomicBool,
    view_online: Mutex<bool>,
    loaded_url: Mutex<Option<Url>>,
    /// The latest update state, replayed whenever the service page loads.
    update_script: Mutex<String>,
    /// Update requests seen from the page; the smoke test has no worker to receive them.
    page_requests: Arc<AtomicUsize>,
    language: Mutex<LanguageStore>,
    tray: Mutex<Option<TrayItems>>,
    app_menu: Mutex<Option<app_menu::AppMenu>>,
    health: Mutex<Option<Result<Health, String>>>,
    action: Mutex<ActionStatus>,
}

#[derive(Clone)]
enum ActionStatus {
    Idle,
    Running(JobAction),
    Installing,
    Complete(Text),
    Failed(Text, String),
}

#[derive(Clone)]
struct TrayItems {
    menu: Menu<tauri::Wry>,
    open: MenuItem<tauri::Wry>,
    refresh: MenuItem<tauri::Wry>,
    service: Submenu<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    modules: Submenu<tauri::Wry>,
    action: MenuItem<tauri::Wry>,
    start: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    install: MenuItem<tauri::Wry>,
    settings: MenuItem<tauri::Wry>,
    update: UpdateMenu,
}

fn main() {
    let smoke_test = std::env::args().any(|arg| arg == "--smoke-test");
    tauri::Builder::default()
        // Register first: a second process only restores this instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            restore_window(app);
            request_refresh(app);
        }))
        // Used from Rust only (update.rs); the capability grants the webview none of its commands.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // No invoke_handler: neither the daemon page nor fallback controls native APIs.
        .setup(move |app| {
            let (requests, receiver) = mpsc::sync_channel(4);
            let (updates, update_receiver) = mpsc::sync_channel(2);
            let page_updates = updates.clone();
            let page_requests = Arc::new(AtomicUsize::new(0));
            let seen_requests = page_requests.clone();
            let current = app.package_info().version.to_string();
            let language = LanguageStore::load(
                (!smoke_test)
                    .then(|| app.path().app_config_dir())
                    .transpose()?
                    .map(|dir| dir.join("language.json")),
            );
            let initial_language = language.view;
            app.manage(NativeState {
                requests,
                updates,
                action_pending: AtomicBool::new(false),
                view_online: Mutex::new(false),
                loaded_url: Mutex::new(None),
                update_script: Mutex::new(UpdateView::idle(current).script()),
                page_requests,
                language: Mutex::new(language),
                tray: Mutex::new(None),
                app_menu: Mutex::new(None),
                health: Mutex::new(None),
                action: Mutex::new(ActionStatus::Idle),
            });
            let native_menu = app_menu::AppMenu::new(app.handle(), initial_language.locale)?;
            *app.state::<NativeState>()
                .app_menu
                .lock()
                .expect("application menu") = Some(native_menu);
            let window_actions = app.handle().clone();
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Nootify")
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(16.0, 28.0))
                .initialization_script(initial_language.initialization_script())
                .initialization_script(include_str!("../../desktop/titlebar.js"))
                .inner_size(1180.0, 760.0)
                .min_inner_size(640.0, 420.0)
                .center()
                // Let macOS and WebKit follow changes to the system appearance.
                .theme(None)
                // WebKit asks this policy first even for target=_blank links, so GitHub must be
                // handed to the default browser here; cancelling also keeps this window in place.
                .on_navigation(move |url| {
                    if let Some(preference) = language::page_request(url) {
                        let trusted = window_actions
                            .state::<NativeState>()
                            .loaded_url
                            .lock()
                            .expect("loaded page")
                            .as_ref()
                            .is_some_and(|source| trusted_document(source, smoke_test));
                        if trusted {
                            change_language(&window_actions, preference);
                        }
                        // A preference request never replaces the page, even if it is untrusted.
                        return false;
                    }
                    // Fixed titlebar requests keep dragging independent of webview IPC permissions.
                    if let Some(action) = window_action(url) {
                        if let Some(window) = window_actions.get_webview_window(MAIN_WINDOW) {
                            match action {
                                WindowAction::Drag => {
                                    let _ = window.start_dragging();
                                }
                                WindowAction::Zoom => {
                                    if window.is_maximized().unwrap_or(false) {
                                        let _ = window.unmaximize();
                                    } else {
                                        let _ = window.maximize();
                                    }
                                }
                            }
                        }
                        return false;
                    }
                    // Update requests are handled by the worker; see update.rs.
                    if let Some(request) = update::page_request(url) {
                        seen_requests.fetch_add(1, Ordering::SeqCst);
                        let _ = page_updates.try_send(request);
                        return false;
                    }
                    if is_github_link(url)
                        || is_tailscale_link(url)
                        || is_feishu_permission_link(url)
                    {
                        open_in_browser(url);
                        return false;
                    }
                    navigation_allowed(url) || (smoke_test && smoke::is_preview(url))
                })
                .on_page_load(move |window, payload| {
                    let state = window.state::<NativeState>();
                    *state.loaded_url.lock().expect("page-load state") = match payload.event() {
                        PageLoadEvent::Started => None,
                        PageLoadEvent::Finished => Some(payload.url().clone()),
                    };
                    if matches!(payload.event(), PageLoadEvent::Finished)
                        && trusted_document(payload.url(), smoke_test)
                    {
                        let language = state.language.lock().expect("language state").view;
                        let _ = window.eval(language.script());
                        // A load starts the page with no update state, including when the service returns.
                        let script = state.update_script.lock().expect("update state").clone();
                        let _ = window.eval(script);
                    }
                })
                // window.open() bypasses the policy above; it gets the same treatment, nothing else opens.
                .on_new_window(|url, _| {
                    if is_github_link(&url)
                        || is_tailscale_link(&url)
                        || is_feishu_permission_link(&url)
                    {
                        open_in_browser(&url);
                    }
                    NewWindowResponse::Deny
                })
                .disable_drag_drop_handler()
                .build()?;
            let tray_items = create_tray(app.handle())?;
            *app.state::<NativeState>().tray.lock().expect("native tray") =
                Some(tray_items.clone());
            if smoke_test {
                // Exercise real windows/tray without stopping or restarting the daemon. The
                // receivers are dropped, so no menu action can install a service or an update.
                smoke::run(app.handle().clone(), tray_items);
            } else {
                let home = app.path().home_dir()?;
                let bundled = BundledService::current();
                let handle = app.handle().clone();
                update::spawn(
                    handle.clone(),
                    update_receiver,
                    tray_items.update.clone(),
                    LaunchAgent::new(home.clone()),
                    bundled.clone().ok().flatten(),
                );
                let agent = LaunchAgent::new(home);
                std::thread::spawn(move || {
                    service_worker(handle, receiver, tray_items, agent, bundled)
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Cannot hide Nootify window: {error}");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Cannot create Nootify desktop shell")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                restore_window(app);
                request_refresh(app);
            }
        });
}

fn restore_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = app.show();
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_refresh(app: &AppHandle) {
    if let Some(state) = app.try_state::<NativeState>() {
        let _ = state.requests.try_send(Request::Refresh);
    }
}

/// Menu shortcuts use the existing local page; they never grant the webview native permissions.
fn open_settings(app: &AppHandle, about: bool) {
    restore_window(app);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let fragment = if about {
            "#/settings/about"
        } else {
            "#/settings/general"
        };
        let _ = window.eval(format!("location.hash = '{}'", fragment));
    }
    request_refresh(app);
}

fn language_view(app: &AppHandle) -> LanguageView {
    app.state::<NativeState>()
        .language
        .lock()
        .expect("language state")
        .view
}

fn change_language(app: &AppHandle, preference: Preference) {
    let state = app.state::<NativeState>();
    {
        let mut language = state.language.lock().expect("language state");
        if let Err(error) = language.set(preference) {
            eprintln!("Cannot save app language preference: {error}");
        }
    }
    publish_language(app);
}

fn refresh_system_language(app: &AppHandle) {
    let changed = app
        .state::<NativeState>()
        .language
        .lock()
        .expect("language state")
        .refresh_system();
    if changed.is_some() {
        publish_language(app);
    }
}

fn publish_language(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Read on the main thread, so a queued system refresh cannot replay an older preference.
        let view = language_view(&handle);
        if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
            if let Err(error) = language::refresh_initialization(&window, view) {
                eprintln!("Cannot refresh document language: {error}");
            }
            let _ = window.eval(view.script());
        }
        let items = handle
            .state::<NativeState>()
            .tray
            .lock()
            .expect("native tray")
            .clone();
        if let Some(items) = items {
            relocalize_tray(&handle, &items);
        }
    });
}

fn relocalize_tray(app: &AppHandle, items: &TrayItems) {
    let handle = app.clone();
    let items = items.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<NativeState>();
        let locale = language_view(&handle).locale;
        for (item, key) in [
            (&items.open, Text::Open),
            (&items.refresh, Text::Refresh),
            (&items.start, Text::RetryStart),
            (&items.restart, Text::Restart),
            (&items.install, Text::InstallService),
            (&items.settings, Text::Settings),
            (&items.quit, Text::Quit),
        ] {
            let _ = item.set_text(locale.text(key));
        }
        let _ = items.service.set_text(locale.text(Text::BackgroundService));
        let _ = items.modules.set_text(locale.text(Text::Modules));
        let app_menu = state.app_menu.lock().expect("application menu").clone();
        if let Some(menu) = app_menu {
            menu.relocalize(locale);
        }
        let health = state.health.lock().expect("health state").clone();
        if let Some(health) = health {
            render_health_items(&handle, &items, &health);
        } else {
            let _ = items.status.set_text(locale.text(Text::CheckingHealth));
            render_modules(
                &handle,
                &items.modules,
                &[locale.text(Text::CheckingModules).into()],
            );
        }
        render_action_items(&handle, &items);
        items.update.relocalize(&handle);
    });
}

fn create_tray(app: &AppHandle) -> tauri::Result<TrayItems> {
    let locale = language_view(app).locale;
    let open = MenuItem::with_id(app, "open", locale.text(Text::Open), true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        "status",
        locale.text(Text::CheckingHealth),
        false,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(
        app,
        "refresh",
        locale.text(Text::Refresh),
        true,
        None::<&str>,
    )?;
    let modules = Submenu::with_id_and_items(
        app,
        "modules",
        locale.text(Text::Modules),
        true,
        &[&MenuItem::new(
            app,
            locale.text(Text::CheckingModules),
            false,
            None::<&str>,
        )?],
    )?;
    let action = MenuItem::with_id(
        app,
        "action",
        locale.text(Text::ServiceKeepsRunning),
        false,
        None::<&str>,
    )?;
    let start = MenuItem::with_id(
        app,
        "start",
        locale.text(Text::RetryStart),
        false,
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(
        app,
        "restart",
        locale.text(Text::Restart),
        false,
        None::<&str>,
    )?;
    // Enabled by render_install only while no LaunchAgent plist exists.
    let install = MenuItem::with_id(
        app,
        "install_service",
        locale.text(Text::InstallService),
        false,
        None::<&str>,
    )?;
    let service = Submenu::with_id_and_items(
        app,
        "service",
        locale.text(Text::BackgroundService),
        true,
        &[
            &modules,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &restart,
            &install,
            &PredefinedMenuItem::separator(app)?,
            &action,
        ],
    )?;
    let current = app.package_info().version.to_string();
    let update_status = MenuItem::with_id(
        app,
        "update_status",
        locale.format(Text::CurrentVersion, &[("version", &update::tag(&current))]),
        false,
        None::<&str>,
    )?;
    let check_update = MenuItem::with_id(
        app,
        update::CHECK_ID,
        locale.text(Text::CheckUpdate),
        true,
        None::<&str>,
    )?;
    // Inserted below Check for Updates only while an update is available.
    let install_update = MenuItem::with_id(
        app,
        update::INSTALL_ID,
        locale.text(Text::InstallUpdate),
        false,
        None::<&str>,
    )?;
    let about = MenuItem::with_id(
        app,
        "about",
        locale.text(Text::UpdateDetails),
        false,
        None::<&str>,
    )?;
    let updates = Submenu::with_id_and_items(
        app,
        "updates",
        locale.text(Text::SoftwareUpdates),
        true,
        &[&update_status, &check_update, &about],
    )?;
    let settings = MenuItem::with_id(
        app,
        "settings",
        locale.text(Text::Settings),
        false,
        Some("CmdOrCtrl+,"),
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        locale.text(Text::Quit),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &service,
            &updates,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let items = TrayItems {
        menu: menu.clone(),
        open,
        refresh,
        service,
        quit,
        status,
        modules,
        action,
        start,
        restart,
        install,
        settings,
        update: UpdateMenu::new(
            updates,
            update_status,
            check_update,
            install_update,
            about,
            current,
        ),
    };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray-template.png"
        ))?)
        .icon_as_template(true)
        .tooltip("Nootify")
        .menu(&menu)
        // Like other macOS menu-bar items, a click opens the menu; 打开 shows the window.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                restore_window(app);
                request_refresh(app);
            }
            "refresh" => request_refresh(app),
            "settings" => open_settings(app, false),
            "about" => open_settings(app, true),
            id @ ("start" | "restart" | "install_service") => {
                let state = app.state::<NativeState>();
                if !state.action_pending.swap(true, Ordering::SeqCst) {
                    let request = match id {
                        "start" => Request::Job(JobAction::Start),
                        "restart" => Request::Job(JobAction::Restart),
                        _ => Request::Install,
                    };
                    if state.requests.try_send(request).is_err() {
                        state.action_pending.store(false, Ordering::SeqCst);
                    }
                }
            }
            update::CHECK_ID => {
                let _ = app
                    .state::<NativeState>()
                    .updates
                    .try_send(UpdateRequest::Check);
            }
            update::INSTALL_ID => {
                let _ = app
                    .state::<NativeState>()
                    .updates
                    .try_send(UpdateRequest::Install);
            }
            // Exit only the desktop process. There is intentionally no daemon cleanup.
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(items)
}

fn service_worker(
    app: AppHandle,
    receiver: Receiver<Request>,
    items: TrayItems,
    agent: LaunchAgent,
    bundled: Result<Option<BundledService>, String>,
) {
    let client = match health_client() {
        Ok(client) => client,
        Err(error) => {
            render_health(
                &app,
                &items,
                &Err(format!("Cannot initialize health client: {error}")),
            );
            return;
        }
    };
    // Opening the app is sufficient: install on first use or load the existing job.
    // A healthy service is reused without restarting it or opening another receiver.
    if check_health(&client).is_err() {
        run_action(
            &app,
            &items,
            ActionStatus::Running(JobAction::Start),
            Text::StartService,
            || {
                if agent.plist_present() {
                    agent.request(JobAction::Start)?;
                    return Ok(Text::StartRequested);
                }
                match &bundled {
                    Ok(Some(bundled)) => agent.install(bundled)?,
                    Ok(None) => return Err("development builds do not bundle the service".into()),
                    Err(error) => return Err(error.clone()),
                }
                Ok(Text::AutoInstalled)
            },
        );
    }
    loop {
        refresh_system_language(&app);
        let health = check_health(&client);
        render_health(&app, &items, &health);
        render_install(&app, &items, agent.plist_present());
        match receiver.recv_timeout(POLL_INTERVAL) {
            Ok(Request::Job(action)) => run_action(
                &app,
                &items,
                ActionStatus::Running(action),
                action.label(),
                || {
                    agent.request(action).map(|()| match action {
                        JobAction::Start => Text::StartRequested,
                        JobAction::Restart => Text::RestartRequested,
                    })
                },
            ),
            // Blocks only this worker: the installer is bounded by a timeout.
            Ok(Request::Install) => run_action(
                &app,
                &items,
                ActionStatus::Installing,
                Text::InstallService,
                || {
                    match &bundled {
                        Ok(Some(bundled)) => agent.install(bundled),
                        Ok(None) => Err("development builds do not bundle the service".into()),
                        Err(error) => Err(error.clone()),
                    }
                    .map(|()| Text::Installed)
                },
            ),
            Ok(Request::Refresh) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn run_action(
    app: &AppHandle,
    items: &TrayItems,
    progress: ActionStatus,
    label: Text,
    action: impl FnOnce() -> Result<Text, String>,
) {
    let state = app.state::<NativeState>();
    state.action_pending.store(true, Ordering::SeqCst);
    *state.action.lock().expect("action state") = progress;
    let _ = items.start.set_enabled(false);
    let _ = items.restart.set_enabled(false);
    let _ = items.install.set_enabled(false);
    refresh_action(app, items);
    *state.action.lock().expect("action state") = match action() {
        Ok(key) => ActionStatus::Complete(key),
        Err(error) => ActionStatus::Failed(label, error),
    };
    refresh_action(app, items);
    state.action_pending.store(false, Ordering::SeqCst);
}

fn refresh_action(app: &AppHandle, items: &TrayItems) {
    let handle = app.clone();
    let items = items.clone();
    let _ = app.run_on_main_thread(move || render_action_items(&handle, &items));
}

fn render_action_items(app: &AppHandle, items: &TrayItems) {
    let locale = language_view(app).locale;
    let action = app
        .state::<NativeState>()
        .action
        .lock()
        .expect("action state")
        .clone();
    let text = match action {
        ActionStatus::Idle => locale.text(Text::ServiceKeepsRunning).into(),
        ActionStatus::Running(JobAction::Start) => locale.text(Text::StartingService).into(),
        ActionStatus::Running(JobAction::Restart) => locale.text(Text::RestartingService).into(),
        ActionStatus::Installing => locale.text(Text::InstallingService).into(),
        ActionStatus::Complete(key) => locale.text(key).into(),
        ActionStatus::Failed(key, error) => locale.format(
            Text::ActionFailed,
            &[("action", locale.text(key)), ("error", &error)],
        ),
    };
    let _ = items.action.set_text(menu_text(&text));
}

/// 安装后台服务 is available only while no LaunchAgent plist exists; an existing one is never rewritten.
fn render_install(app: &AppHandle, items: &TrayItems, plist_present: bool) {
    let busy = app
        .state::<NativeState>()
        .action_pending
        .load(Ordering::SeqCst);
    let _ = items.install.set_enabled(!plist_present && !busy);
}

fn render_health(app: &AppHandle, items: &TrayItems, health: &Result<Health, String>) {
    *app.state::<NativeState>()
        .health
        .lock()
        .expect("health state") = Some(health.clone());
    let handle = app.clone();
    let items = items.clone();
    let _ = app.run_on_main_thread(move || {
        let health = handle
            .state::<NativeState>()
            .health
            .lock()
            .expect("health state")
            .clone();
        if let Some(health) = health {
            render_health_items(&handle, &items, &health);
        }
    });
}

fn render_health_items(app: &AppHandle, items: &TrayItems, health: &Result<Health, String>) {
    let locale = language_view(app).locale;
    let (status, detail, modules) = match health {
        Ok(health) => {
            let modules = health
                .modules
                .iter()
                .map(|module| menu_text(&module_label(locale, &module.name, &module.status)))
                .collect::<Vec<_>>();
            (
                locale.text(Text::Running),
                locale.format(Text::ModuleDetail, &[("modules", &modules.join(" · "))]),
                modules,
            )
        }
        Err(error) => (
            locale.text(Text::Offline),
            locale.format(Text::Reason, &[("error", error)]),
            vec![menu_text(error)],
        ),
    };
    let _ = items.status.set_text(status);
    render_modules(app, &items.modules, &modules);
    let busy = app
        .state::<NativeState>()
        .action_pending
        .load(Ordering::SeqCst);
    let _ = items.start.set_enabled(health.is_err() && !busy);
    let _ = items.restart.set_enabled(!busy);
    let _ = items.settings.set_enabled(health.is_ok());
    let _ = items.update.about.set_enabled(health.is_ok());
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("{status}\n{}", menu_text(&detail))));
    }
    if let Err(error) = set_service_view(app, health.is_ok()) {
        eprintln!("Cannot display service page: {error}");
    }
}

fn module_label(locale: Locale, name: &str, status: &str) -> String {
    let name = match name {
        "sessions" => locale.text(Text::Sessions),
        "lark" => locale.text(Text::Lark),
        "pulls" => locale.text(Text::Pulls),
        "agents" => locale.text(Text::Agents),
        "slack" => "Slack",
        "telegram" => "Telegram",
        name => name,
    };
    let status = match status {
        "ready" => locale.text(Text::Ready),
        "disabled" => locale.text(Text::Disabled),
        "connecting" => locale.text(Text::Connecting),
        "reconnecting" => locale.text(Text::Reconnecting),
        "failed" => locale.text(Text::Failed),
        "stopped" => locale.text(Text::Stopped),
        "refreshing" => locale.text(Text::Refreshing),
        "signed_out" => locale.text(Text::SignedOut),
        "stale" => locale.text(Text::Stale),
        "error" => locale.text(Text::Error),
        "idle" => locale.text(Text::Idle),
        status => status,
    };
    locale.format(Text::ModuleStatus, &[("name", name), ("status", status)])
}

/// Leave an open native submenu untouched when the three-second health poll has not changed it.
fn render_modules(app: &AppHandle, menu: &Submenu<tauri::Wry>, labels: &[String]) {
    let Ok(current) = menu.items() else { return };
    let unchanged = current.len() == labels.len()
        && current.iter().zip(labels).all(|(item, label)| {
            item.as_menuitem()
                .and_then(|item| item.text().ok())
                .as_ref()
                == Some(label)
        });
    if unchanged {
        return;
    }
    for item in current {
        let _ = menu.remove(&item);
    }
    for label in labels {
        if let Ok(item) = MenuItem::new(app, label, false, None::<&str>) {
            let _ = menu.append(&item);
        }
    }
}

fn set_service_view(app: &AppHandle, online: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let state = app.state::<NativeState>();
        let mut current = state.view_online.lock().expect("view state");
        // Do not query WKWebView.URL before its first load; WebKit can return nil.
        // Keep filters, selected tab, and scroll position through successful polls.
        if *current != online {
            let target = if online { SERVICE_URL } else { FALLBACK_URL };
            window.navigate(Url::parse(target).expect("fixed app URL"))?;
            *current = online;
        }
    }
    Ok(())
}

fn no_credentials(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none()
}

fn is_service_ui(url: &Url) -> bool {
    no_credentials(url)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(9417)
        && url.path() == "/"
}

fn is_fallback(url: &Url) -> bool {
    no_credentials(url)
        && url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        // Tauri opens WebviewUrl::App("index.html") as bare `tauri://localhost`: a non-special
        // URL whose path is empty, which current WebKit passes to the policy unchanged.
        && matches!(url.path(), "" | "/" | "/index.html")
}

#[derive(Debug, PartialEq, Eq)]
enum WindowAction {
    Drag,
    Zoom,
}

fn window_action(url: &Url) -> Option<WindowAction> {
    if !no_credentials(url)
        || url.scheme() != "nootify"
        || url.host_str() != Some("window")
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    match url.path() {
        "/drag" => Some(WindowAction::Drag),
        "/zoom" => Some(WindowAction::Zoom),
        _ => None,
    }
}

fn navigation_allowed(url: &Url) -> bool {
    is_service_ui(url) || is_fallback(url)
}

fn trusted_document(url: &Url, smoke_test: bool) -> bool {
    navigation_allowed(url) || (smoke_test && cfg!(debug_assertions) && smoke::is_preview(url))
}

fn is_github_link(url: &Url) -> bool {
    no_credentials(url)
        && url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
}

fn is_tailscale_link(url: &Url) -> bool {
    no_credentials(url)
        && url.scheme() == "https"
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && match url.host_str() {
            Some("login.tailscale.com") => url.path().strip_prefix("/a/").is_some_and(|token| {
                !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_alphanumeric())
            }),
            _ => false,
        }
}

fn is_feishu_permission_link(url: &Url) -> bool {
    no_credentials(url)
        && url.scheme() == "https"
        && url.host_str() == Some("open.feishu.cn")
        && url.port().is_none()
        && url.fragment().is_none()
        && (matches!(url.path(), "/app" | "/app/")
            || url
                .path()
                .strip_prefix("/app/cli_")
                .and_then(|path| path.strip_suffix("/auth"))
                .is_some_and(|id| {
                    id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                }))
}

fn open_in_browser(url: &Url) {
    match std::process::Command::new("/usr/bin/open")
        .arg(url.as_str())
        .spawn()
    {
        // Reap the short-lived launcher so repeated clicks leave no zombie processes.
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => eprintln!("Cannot open {url}: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feishu_permission_links_open_only_the_official_app_console() {
        for link in [
            "https://open.feishu.cn/app",
            "https://open.feishu.cn/app/cli_0123456789abcdef/auth?q=contact:group:readonly&op_from=openapi",
        ] {
            assert!(is_feishu_permission_link(&Url::parse(link).unwrap()), "{link}");
        }
        for link in [
            "http://open.feishu.cn/app",
            "https://open.feishu.cn.evil.test/app",
            "https://user@open.feishu.cn/app",
            "https://open.feishu.cn:8443/app",
            "https://open.feishu.cn/app/cli_invalid/auth",
            "https://open.feishu.cn/app/cli_0123456789abcdef/settings",
            "https://open.feishu.cn/document/anything",
            "https://open.feishu.cn/app#other",
        ] {
            assert!(
                !is_feishu_permission_link(&Url::parse(link).unwrap()),
                "{link}"
            );
        }
    }

    #[test]
    fn navigation_is_limited_to_our_two_documents() {
        for allowed in [
            SERVICE_URL,
            "http://127.0.0.1:9417/#logs",
            FALLBACK_URL,
            "tauri://localhost/",
            // The window's first navigation.
            "tauri://localhost",
        ] {
            assert!(
                navigation_allowed(&Url::parse(allowed).unwrap()),
                "{allowed}"
            );
        }
        for blocked in [
            "https://example.com/",
            "http://127.0.0.1:9418/",
            "http://localhost:9417/",
            "http://127.0.0.1:9417.evil.example/",
            "http://127.0.0.1:9417/v1/sessions",
            "http://user@127.0.0.1:9417/",
            "tauri://elsewhere/index.html",
            "tauri://localhost/other.html",
            "file:///etc/passwd",
            "data:text/html,hello",
            "javascript:alert(1)",
            "about:blank",
        ] {
            let accepted = Url::parse(blocked).is_ok_and(|url| navigation_allowed(&url));
            assert!(!accepted, "{blocked}");
        }
    }

    #[test]
    fn language_changes_only_trust_existing_native_documents() {
        for trusted in [SERVICE_URL, FALLBACK_URL, "tauri://localhost"] {
            assert!(trusted_document(&Url::parse(trusted).unwrap(), false));
        }
        for untrusted in [
            "https://example.com/",
            "http://127.0.0.1:9437/",
            "http://localhost:9417/",
            "http://user@127.0.0.1:9417/",
            "tauri://localhost/other.html",
            "about:blank",
        ] {
            assert!(
                !trusted_document(&Url::parse(untrusted).unwrap(), false),
                "{untrusted}"
            );
        }
    }

    #[test]
    fn module_statuses_are_localized_and_unknown_values_remain_literal() {
        assert_eq!(
            module_label(Locale::English, "sessions", "ready"),
            "Sessions: Ready"
        );
        assert_eq!(
            module_label(Locale::Chinese, "lark", "reconnecting"),
            "飞书：重新连接中"
        );
        assert_eq!(
            module_label(Locale::English, "pulls", "signed_out"),
            "PR: Signed Out"
        );
        assert_eq!(
            module_label(Locale::Chinese, "new module", "new status"),
            "new module：new status"
        );
    }

    #[test]
    fn titlebar_requests_only_allow_fixed_window_actions() {
        assert_eq!(
            window_action(&Url::parse("nootify://window/drag").unwrap()),
            Some(WindowAction::Drag)
        );
        assert_eq!(
            window_action(&Url::parse("nootify://window/zoom").unwrap()),
            Some(WindowAction::Zoom)
        );
        for blocked in [
            "https://window/drag",
            "nootify://update/drag",
            "nootify://window/close",
            "nootify://user@window/drag",
            "nootify://window:9417/drag",
            "nootify://window/drag?target=other",
            "nootify://window/zoom#other",
            "nootify://window/drag/",
            "nootify://window/",
        ] {
            assert_eq!(
                window_action(&Url::parse(blocked).unwrap()),
                None,
                "{blocked}"
            );
        }
    }

    #[test]
    fn only_plain_github_links_open_in_the_browser() {
        for allowed in [
            "https://github.com/idy/nootify/pull/1",
            "https://github.com/espressif/esp-idf/pull/18890#discussion_r1",
        ] {
            assert!(is_github_link(&Url::parse(allowed).unwrap()), "{allowed}");
        }
        for blocked in [
            "http://github.com/idy/nootify/pull/1",
            "https://github.com.evil.example/pull/1",
            "https://gist.github.com/x",
            "https://user@github.com/idy/nootify",
            "https://github.com:8443/idy/nootify",
            "file:///Applications/Calculator.app",
            "javascript:alert(1)",
        ] {
            let accepted = Url::parse(blocked).is_ok_and(|url| is_github_link(&url));
            assert!(!accepted, "{blocked}");
        }
    }

    #[test]
    fn only_official_tailscale_authorization_links_open() {
        assert!(is_tailscale_link(
            &Url::parse("https://login.tailscale.com/a/abc123").unwrap()
        ));
        for link in [
            "https://login.tailscale.com.evil.example/a/abc123",
            "http://login.tailscale.com/a/abc123",
            "https://user@login.tailscale.com/a/abc123",
            "https://login.tailscale.com:8443/a/abc123",
            "https://login.tailscale.com/a/abc123?redirect=elsewhere",
            "https://tailscale.com/admin",
            "https://login.tailscale.com/a/",
        ] {
            assert!(!is_tailscale_link(&Url::parse(link).unwrap()), "{link}");
        }
    }

    #[test]
    fn configuration_grants_no_webview_ipc_or_remote_content_access() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let capabilities = config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap();
        assert_eq!(capabilities.len(), 1);
        assert_eq!(capabilities[0]["local"], false);
        assert!(capabilities[0].get("remote").is_none());
        assert!(capabilities[0]["permissions"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(config["app"]["withGlobalTauri"], false);
    }

    #[test]
    fn bundle_ships_the_service_runtime_and_signed_updates() {
        let text = include_str!("../tauri.conf.json");
        let config: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(config["version"], "../package.json");
        assert!(config["build"]["beforeBuildCommand"]
            .as_str()
            .unwrap()
            .contains("node scripts/stage-service.mjs"));
        let bundle = &config["bundle"];
        assert_eq!(
            bundle["externalBin"],
            serde_json::json!(["binaries/node", "binaries/nootify-tsnet"])
        );
        assert_eq!(bundle["resources"]["resources/service/"], "service/");
        assert_eq!(bundle["targets"], serde_json::json!(["app", "dmg"]));
        assert_eq!(bundle["createUpdaterArtifacts"], true);
        assert_eq!(bundle["macOS"]["signingIdentity"], "-");
        assert_eq!(bundle["macOS"]["entitlements"], "Entitlements.plist");
        let updater = &config["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([
                "https://github.com/idy/nootify/releases/latest/download/latest.json"
            ])
        );
        assert!(updater["pubkey"]
            .as_str()
            .is_some_and(|key| key.len() > 100));
        // Rust drives the updater; no updater permission or capability file reaches the webview.
        assert!(!text.contains("updater:"));
        assert!(
            !std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).exists()
        );
        // The hardened runtime stays on; Node.js gets only the JIT entitlement V8 needs.
        let entitlements = include_str!("../Entitlements.plist");
        assert_eq!(entitlements.matches("<key>").count(), 1);
        assert!(entitlements.contains("<key>com.apple.security.cs.allow-jit</key>"));
    }
}
