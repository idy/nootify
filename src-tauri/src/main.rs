#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "macos"))]
compile_error!("Nootify currently supports macOS only");

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

use service::{
    check_health, health_client, menu_text, BundledService, Health, JobAction, LaunchAgent,
    SERVICE_URL,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use update::{UpdateMenu, UpdateRequest, UpdateView};

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "nootify";
const FALLBACK_URL: &str = "tauri://localhost/index.html";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const INSTALL_LABEL: &str = "安装后台服务";

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
}

#[derive(Clone)]
struct TrayItems {
    status: MenuItem<tauri::Wry>,
    modules: MenuItem<tauri::Wry>,
    action: MenuItem<tauri::Wry>,
    start: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    install: MenuItem<tauri::Wry>,
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
            app.manage(NativeState {
                requests,
                updates,
                action_pending: AtomicBool::new(false),
                view_online: Mutex::new(false),
                loaded_url: Mutex::new(None),
                update_script: Mutex::new(UpdateView::idle(current).script()),
                page_requests,
            });
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Nootify")
                .inner_size(1180.0, 760.0)
                .min_inner_size(640.0, 420.0)
                .center()
                // Let macOS and WebKit follow changes to the system appearance.
                .theme(None)
                // WebKit asks this policy first even for target=_blank links, so GitHub must be
                // handed to the default browser here; cancelling also keeps this window in place.
                .on_navigation(move |url| {
                    // The page's only way to reach native code; see update.rs.
                    if let Some(request) = update::page_request(url) {
                        seen_requests.fetch_add(1, Ordering::SeqCst);
                        let _ = page_updates.try_send(request);
                        return false;
                    }
                    if is_github_link(url) {
                        open_in_browser(url);
                        return false;
                    }
                    navigation_allowed(url)
                })
                .on_page_load(|window, payload| {
                    let state = window.state::<NativeState>();
                    *state.loaded_url.lock().expect("page-load state") = match payload.event() {
                        PageLoadEvent::Started => None,
                        PageLoadEvent::Finished => Some(payload.url().clone()),
                    };
                    // A load starts the page with no update state, including when the service returns.
                    if matches!(payload.event(), PageLoadEvent::Finished)
                        && is_service_ui(payload.url())
                    {
                        let script = state.update_script.lock().expect("update state").clone();
                        let _ = window.eval(script);
                    }
                })
                // window.open() bypasses the policy above; it gets the same treatment, nothing else opens.
                .on_new_window(|url, _| {
                    if is_github_link(&url) {
                        open_in_browser(&url);
                    }
                    NewWindowResponse::Deny
                })
                .disable_drag_drop_handler()
                .build()?;
            let tray_items = create_tray(app.handle())?;
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

fn create_tray(app: &AppHandle) -> tauri::Result<TrayItems> {
    let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "刷新服务状态", true, None::<&str>)?;
    let update_status = MenuItem::with_id(
        app,
        "update_status",
        format!(
            "更新：当前 {}",
            update::tag(&app.package_info().version.to_string())
        ),
        false,
        None::<&str>,
    )?;
    let check_update = MenuItem::with_id(app, update::CHECK_ID, "检查更新", true, None::<&str>)?;
    // Inserted below 检查更新 only while an update is available (UpdateMenu::render).
    let install_update =
        MenuItem::with_id(app, update::INSTALL_ID, "安装更新", false, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "服务：检查中…", false, None::<&str>)?;
    let modules = MenuItem::with_id(app, "modules", "模块：—", false, None::<&str>)?;
    let action = MenuItem::with_id(app, "action", "退出不会停止后台服务", false, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "重试启动服务", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", false, None::<&str>)?;
    // Enabled by render_install only while no LaunchAgent plist exists.
    let install = MenuItem::with_id(app, "install_service", INSTALL_LABEL, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &modules,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &restart,
            &install,
            &action,
            &PredefinedMenuItem::separator(app)?,
            &update_status,
            &check_update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let items = TrayItems {
        status,
        modules,
        action,
        start,
        restart,
        install,
        update: UpdateMenu::new(menu.clone(), update_status, check_update, install_update),
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
        run_action(&app, &items, "启动后台服务", || {
            if agent.plist_present() {
                agent.request(JobAction::Start)?;
                return Ok("后台服务正在启动".into());
            }
            match &bundled {
                Ok(Some(bundled)) => agent.install(bundled)?,
                Ok(None) => return Err("development builds do not bundle the service".into()),
                Err(error) => return Err(error.clone()),
            }
            Ok("后台服务已自动安装并运行".into())
        });
    }
    loop {
        let health = check_health(&client);
        render_health(&app, &items, &health);
        render_install(&app, &items, agent.plist_present());
        match receiver.recv_timeout(POLL_INTERVAL) {
            Ok(Request::Job(action)) => run_action(&app, &items, action.label(), || {
                agent
                    .request(action)
                    .map(|()| format!("已请求{}", action.label()))
            }),
            // Blocks only this worker: the installer is bounded by a timeout.
            Ok(Request::Install) => run_action(&app, &items, INSTALL_LABEL, || {
                match &bundled {
                    Ok(Some(bundled)) => agent.install(bundled),
                    Ok(None) => Err("development builds do not bundle the service".into()),
                    Err(error) => Err(error.clone()),
                }
                .map(|()| "后台服务已安装并运行".to_string())
            }),
            Ok(Request::Refresh) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn run_action(
    app: &AppHandle,
    items: &TrayItems,
    label: &str,
    action: impl FnOnce() -> Result<String, String>,
) {
    app.state::<NativeState>()
        .action_pending
        .store(true, Ordering::SeqCst);
    let _ = items.start.set_enabled(false);
    let _ = items.restart.set_enabled(false);
    let _ = items.install.set_enabled(false);
    let _ = items.action.set_text(format!("正在{label}…"));
    let text = action().unwrap_or_else(|error| format!("{label}失败：{error}"));
    let _ = items.action.set_text(menu_text(&text));
    app.state::<NativeState>()
        .action_pending
        .store(false, Ordering::SeqCst);
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
    let (status, detail) = match health {
        Ok(health) => (
            "服务：运行中",
            format!(
                "模块：{}",
                health
                    .modules
                    .iter()
                    .map(|module| format!("{}: {}", module.name, module.status))
                    .collect::<Vec<_>>()
                    .join(" · ")
            ),
        ),
        Err(error) => ("服务：未连接", format!("原因：{error}")),
    };
    let _ = items.status.set_text(status);
    let _ = items.modules.set_text(menu_text(&detail));
    let busy = app
        .state::<NativeState>()
        .action_pending
        .load(Ordering::SeqCst);
    let _ = items.start.set_enabled(health.is_err() && !busy);
    let _ = items.restart.set_enabled(!busy);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Nootify {status}\n{}", menu_text(&detail))));
    }
    if let Err(error) = set_service_view(app, health.is_ok()) {
        eprintln!("Cannot display service page: {error}");
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

fn navigation_allowed(url: &Url) -> bool {
    is_service_ui(url) || is_fallback(url)
}

fn is_github_link(url: &Url) -> bool {
    no_credentials(url)
        && url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
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
        assert_eq!(bundle["externalBin"], serde_json::json!(["binaries/node"]));
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
