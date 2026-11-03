#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "macos"))]
compile_error!("Nootify currently supports macOS only");

mod service;
mod smoke;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Mutex,
    },
    time::Duration,
};

use service::{
    check_health, health_client, menu_text, Health, JobAction, LaunchAgent, SERVICE_URL,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "nootify";
const FALLBACK_URL: &str = "tauri://localhost/index.html";
const POLL_INTERVAL: Duration = Duration::from_secs(3);

enum Request {
    Refresh,
    Job(JobAction),
}

struct NativeState {
    requests: SyncSender<Request>,
    action_pending: AtomicBool,
    view_online: Mutex<bool>,
    loaded_url: Mutex<Option<Url>>,
}

#[derive(Clone)]
struct TrayItems {
    status: MenuItem<tauri::Wry>,
    modules: MenuItem<tauri::Wry>,
    action: MenuItem<tauri::Wry>,
    start: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
}

fn main() {
    let smoke_test = std::env::args().any(|arg| arg == "--smoke-test");
    tauri::Builder::default()
        // Register first: a second process only restores this instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            restore_window(app);
            request_refresh(app);
        }))
        // No invoke_handler: neither the daemon page nor fallback controls native APIs.
        .setup(move |app| {
            let (requests, receiver) = mpsc::sync_channel(4);
            app.manage(NativeState {
                requests,
                action_pending: AtomicBool::new(false),
                view_online: Mutex::new(false),
                loaded_url: Mutex::new(None),
            });
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Nootify")
                .inner_size(1180.0, 760.0)
                .min_inner_size(640.0, 420.0)
                .center()
                // Match the dark page so the native title bar and first paint do not flash white.
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(24, 24, 27, 255))
                // WebKit asks this policy first even for target=_blank links, so GitHub must be
                // handed to the default browser here; cancelling also keeps this window in place.
                .on_navigation(|url| {
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
                // Exercise real windows/tray without stopping or restarting the daemon.
                smoke::run(app.handle().clone(), tray_items);
            } else {
                let agent = LaunchAgent::new(app.path().home_dir()?);
                let handle = app.handle().clone();
                std::thread::spawn(move || service_worker(handle, receiver, tray_items, agent));
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
    let items = TrayItems {
        status: MenuItem::with_id(app, "status", "服务：检查中…", false, None::<&str>)?,
        modules: MenuItem::with_id(app, "modules", "模块：—", false, None::<&str>)?,
        action: MenuItem::with_id(app, "action", "退出不会停止后台服务", false, None::<&str>)?,
        start: MenuItem::with_id(app, "start", "启动服务", true, None::<&str>)?,
        restart: MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?,
    };
    let quit = MenuItem::with_id(app, "quit", "退出", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &items.status,
            &items.modules,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &items.start,
            &items.restart,
            &items.action,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
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
            "start" | "restart" => {
                let state = app.state::<NativeState>();
                if !state.action_pending.swap(true, Ordering::SeqCst) {
                    let action = if event.id.as_ref() == "start" {
                        JobAction::Start
                    } else {
                        JobAction::Restart
                    };
                    if state.requests.try_send(Request::Job(action)).is_err() {
                        state.action_pending.store(false, Ordering::SeqCst);
                    }
                }
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
    loop {
        let health = check_health(&client);
        render_health(&app, &items, &health);
        match receiver.recv_timeout(POLL_INTERVAL) {
            Ok(Request::Job(action)) => {
                let _ = items.start.set_enabled(false);
                let _ = items.restart.set_enabled(false);
                let _ = items.action.set_text(format!("正在{}…", action.label()));
                let result = agent.request(action);
                let text = match result {
                    Ok(()) => format!("已请求{}", action.label()),
                    Err(error) => format!("{}失败：{}", action.label(), error),
                };
                let _ = items.action.set_text(menu_text(&text));
                app.state::<NativeState>()
                    .action_pending
                    .store(false, Ordering::SeqCst);
            }
            Ok(Request::Refresh) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
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
        && matches!(url.path(), "/" | "/index.html")
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
}
