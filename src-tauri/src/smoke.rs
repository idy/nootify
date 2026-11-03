//! Opt-in native runtime check: `nootify --smoke-test`.
//! Run after quitting other desktop instances. No launchd operations are performed.
use std::{
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::{
    is_fallback, is_service_ui, render_health, restore_window,
    service::{check_health, health_client},
    NativeState, TrayItems, MAIN_WINDOW, TRAY_ID,
};

pub fn run(app: AppHandle, items: TrayItems) {
    thread::spawn(move || {
        let result = exercise(&app, &items);
        match result {
            Ok(online) => {
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
                        "daemon_healthy": online,
                        "live_ui_restored": online,
                        "remote_ipc_denied": online,
                        "daemon_control_invoked": false
                    })
                );
                app.exit(0);
            }
            Err(error) => {
                eprintln!(
                    "{}",
                    json!({"ok": false, "error": error, "daemon_control_invoked": false})
                );
                app.exit(1);
            }
        }
    });
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

fn exercise(app: &AppHandle, items: &TrayItems) -> Result<bool, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("Main window missing")?;
    wait_for("native tray has a screen rectangle", || {
        app.tray_by_id(TRAY_ID)
            .and_then(|tray| tray.rect().ok().flatten())
            .is_some_and(|rect| rect.size.to_physical::<u32>(1.0).width > 0)
    })?;
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
    Ok(online)
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
