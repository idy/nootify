//! Opt-in native runtime check: `nootify --smoke-test`.
//! Run after quitting other desktop instances. No launchd operations are performed, and neither
//! the service installer nor an update check or install ever runs: their workers are not started.
use std::{
    process::Command,
    sync::{atomic::Ordering, mpsc},
    thread,
    time::{Duration, Instant},
};

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

use crate::{
    is_fallback, is_service_ui, render_health, render_install, restore_window,
    service::{check_health, health_client, BundledService, LaunchAgent},
    update::{tag, UpdateView},
    NativeState, TrayItems, INSTALL_LABEL, MAIN_WINDOW, TRAY_ID,
};

struct Report {
    online: bool,
    plist_present: bool,
    bundled_node: Option<String>,
    updater_ready: bool,
}

pub fn run(app: AppHandle, items: TrayItems) {
    thread::spawn(move || {
        let result = exercise(&app, &items);
        match result {
            Ok(report) => {
                println!(
                    "{}",
                    json!({
                        "ok": true,
                        "tray_present": true,
                        "close_hides_without_destroying": true,
                        "restore_visible_and_focused": true,
                        "single_instance_restores_window": true,
                        "bundled_fallback": true,
                        "fallback_ipc_denied": true,
                        "daemon_healthy": report.online,
                        "live_ui_restored": report.online,
                        "remote_ipc_denied": report.online,
                        "page_update_bridge": report.online,
                        "launch_agent_plist_present": report.plist_present,
                        "service_install_enabled": !report.plist_present,
                        "bundled_node": report.bundled_node,
                        "updater_ready": report.updater_ready,
                        "update_menu_rendered": true,
                        "daemon_control_invoked": false,
                        "service_install_invoked": false,
                        "update_install_invoked": false
                    })
                );
                app.exit(0);
            }
            Err(error) => {
                eprintln!(
                    "{}",
                    json!({
                        "ok": false,
                        "error": error,
                        "daemon_control_invoked": false,
                        "service_install_invoked": false,
                        "update_install_invoked": false
                    })
                );
                app.exit(1);
            }
        }
    });
}

/// The bundle's runtime, updater configuration and tray items, without installing anything.
fn exercise_bundle(app: &AppHandle, items: &TrayItems) -> Result<Report, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    // Only stats the plist path; nothing under ~/Library/LaunchAgents is written or loaded.
    let plist_present = LaunchAgent::new(home).plist_present();
    render_install(app, items, plist_present);
    wait_for(
        "安装后台服务 is enabled exactly when no plist exists",
        || {
            items.install.is_enabled().ok() == Some(!plist_present)
                && items.install.text().ok().as_deref() == Some(INSTALL_LABEL)
        },
    )?;

    // Inside an app bundle the runtime must start under the bundle's signature (V8 needs the JIT
    // entitlement); `--version` starts no service. Development builds have no bundle to check.
    let bundled = BundledService::current()?;
    let bundled_node = bundled
        .as_ref()
        .map(BundledService::node_version)
        .transpose()?;
    let updater_ready = app.updater().is_ok();
    if bundled.is_some() && !updater_ready {
        return Err(format!(
            "Updater is not configured: {}",
            app.updater()
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default()
        ));
    }

    // Render an available update through the production path; the update worker that could
    // install it is not running, and no Update exists to install.
    let menu = &items.update;
    let current = tag(&app.package_info().version.to_string());
    if menu.install_shown() || !menu.check.is_enabled().unwrap_or(false) {
        return Err("Update items are not in their initial state".into());
    }
    menu.render("更新：发现 v0.0.0-smoke", Some("0.0.0-smoke"), false);
    wait_for("安装更新 appears for an available update", || {
        menu.install_shown() && menu.install.text().ok().as_deref() == Some("安装更新 v0.0.0-smoke")
    })?;
    menu.render(&format!("更新：当前 {current}"), None, false);
    wait_for("安装更新 is removed again", || !menu.install_shown())?;
    Ok(Report {
        online: false,
        plist_present,
        bundled_node,
        updater_ready,
    })
}

fn wait_for(description: &str, mut predicate: impl FnMut() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if predicate() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(80));
    }
    Err(format!("Timed out: {description}"))
}

fn exercise(app: &AppHandle, items: &TrayItems) -> Result<Report, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("Main window missing")?;
    wait_for("native tray has a screen rectangle", || {
        app.tray_by_id(TRAY_ID)
            .and_then(|tray| tray.rect().ok().flatten())
            .is_some_and(|rect| rect.size.to_physical::<u32>(1.0).width > 0)
    })?;
    let mut report = exercise_bundle(app, items)?;
    restore_window(app);
    wait_for("initial window visible", || {
        window.is_visible().unwrap_or(false)
    })?;

    // close() emits the same CloseRequested event as the titlebar close control.
    window.close().map_err(|error| error.to_string())?;
    wait_for("close hides, preserving the window", || {
        app.get_webview_window(MAIN_WINDOW).is_some() && !window.is_visible().unwrap_or(true)
    })?;
    // This is the same restore path used by the tray click and Open menu entry.
    restore_window(app);
    wait_for("restore shows and focuses", || {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })?;

    window.close().map_err(|error| error.to_string())?;
    wait_for("window hidden before second launch", || {
        !window.is_visible().unwrap_or(true)
    })?;
    let mut second = Command::new(std::env::current_exe().map_err(|error| error.to_string())?)
        .arg("--smoke-reopen")
        .spawn()
        .map_err(|error| error.to_string())?;
    let exited = wait_for("second instance exits", || {
        second.try_wait().ok().flatten().is_some()
    });
    if exited.is_err() {
        let _ = second.kill();
        let _ = second.wait();
        return Err("Single-instance plugin did not stop the second desktop process".into());
    }
    if !second.wait().map_err(|error| error.to_string())?.success() {
        return Err("Second instance exited unsuccessfully".into());
    }
    wait_for("second launch restores the existing window", || {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })?;

    let health = check_health(&health_client().map_err(|error| error.to_string())?);
    let online = health.is_ok();
    if online {
        render_health(app, items, &health);
        wait_for_live_ui(&window)?;
        check_ipc_denied(&window)?;
        check_update_bridge(&window)?;
    }

    // Simulate an offline result through the production display path, not by
    // stopping the independent service or launching a test HTTP receiver.
    render_health(app, items, &Err("Diagnostic offline transition".into()));
    wait_for("bundled fallback document and image loaded", || {
        let loaded = window
            .state::<NativeState>()
            .loaded_url
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(is_fallback);
        loaded && evaluate(&window, "document.querySelector('h1')?.textContent === '正在等待本机服务' && document.querySelector('.mark')?.naturalWidth > 0").unwrap_or(false)
    })?;
    check_ipc_denied(&window)?;
    render_health(app, items, &health);
    if online {
        wait_for_live_ui(&window)?;
    }
    report.online = online;
    Ok(report)
}

fn wait_for_live_ui(window: &WebviewWindow) -> Result<(), String> {
    wait_for("live daemon UI document loaded", || {
        let loaded = window
            .state::<NativeState>()
            .loaded_url
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(is_service_ui);
        // Also checks, in WebKit itself, that log rows share one height and sidebar footer lines one gap.
        loaded && evaluate(window, "(() => { const one = values => new Set(values.map(Math.round)).size === 1; const rows = [...document.querySelectorAll('#logs-table .row')].map(row => row.getBoundingClientRect().height); const lines = [...document.querySelectorAll('.sidebar-foot .status-line')].filter(line => line.offsetParent).map(line => line.getBoundingClientRect()); const gaps = lines.slice(1).map((line, index) => line.top - lines[index].bottom); return rows.length > 1 && one(rows) && gaps.length > 1 && one(gaps) && document.querySelector('#connection')?.textContent === '实时更新' && document.querySelector('#error')?.hidden === true; })()").unwrap_or(false)
    })
}

fn evaluate(window: &WebviewWindow, expression: &str) -> Result<bool, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(expression, move |result| {
            let _ = sender.try_send(result);
        })
        .map_err(|error| error.to_string())?;
    let result = receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    Ok(result == "true")
}

/// In WebKit itself: pushed state reaches a listener under the page's CSP, and an update request
/// reaches the navigation policy and leaves the page in place. No worker runs to act on it.
fn check_update_bridge(window: &WebviewWindow) -> Result<(), String> {
    window
        .eval("window.addEventListener('nootify-update', event => { window.__nootifySmokeUpdate = event.detail.phase; })")
        .map_err(|error| error.to_string())?;
    window
        .eval(UpdateView::idle("0.0.0-smoke".into()).script())
        .map_err(|error| error.to_string())?;
    let delivered = "window.__nootifySmokeUpdate === 'idle'";
    wait_for("update state reaches the page", || {
        evaluate(window, delivered).unwrap_or(false)
    })?;
    let state = window.state::<NativeState>();
    let before = state.page_requests.load(Ordering::SeqCst);
    window
        .eval("location.href = 'nootify://update/check'")
        .map_err(|error| error.to_string())?;
    wait_for("update request reaches the navigation policy", || {
        state.page_requests.load(Ordering::SeqCst) > before
    })?;
    wait_for("the page survives the cancelled navigation", || {
        evaluate(window, delivered).unwrap_or(false)
    })
}

fn check_ipc_denied(window: &WebviewWindow) -> Result<(), String> {
    window
        .eval(
            r#"
        window.__nootifySmokeIpc = 'pending';
        if (window.__TAURI_INTERNALS__?.invoke) {
            window.__TAURI_INTERNALS__.invoke('plugin:app|version').then(
                () => { window.__nootifySmokeIpc = 'granted'; },
                () => { window.__nootifySmokeIpc = 'denied'; }
            );
        } else { window.__nootifySmokeIpc = 'absent'; }
    "#,
        )
        .map_err(|error| error.to_string())?;
    wait_for("webview has no native API access", || {
        evaluate(
            window,
            "['denied', 'absent'].includes(window.__nootifySmokeIpc)",
        )
        .unwrap_or(false)
    })
}
