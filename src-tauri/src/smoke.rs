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
    is_fallback, is_service_ui,
    language::{Locale, Preference, Text},
    language_view, open_settings, render_health, render_install, restore_window,
    service::{check_health, health_client, BundledService, LaunchAgent},
    update::{Phase, Status, UpdateView},
    NativeState, TrayItems, MAIN_WINDOW, TRAY_ID,
};

/// A debug smoke run may inspect the worktree's loopback UI without replacing the installed service.
fn preview_url() -> Option<tauri::Url> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let url = tauri::Url::parse(&std::env::var("NOOTIFY_SMOKE_UI_URL").ok()?).ok()?;
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && crate::no_credentials(&url)
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

pub fn is_preview(url: &tauri::Url) -> bool {
    let mut document = url.clone();
    document.set_fragment(None);
    preview_url().is_some_and(|preview| document == preview)
}

struct Report {
    online: bool,
    plist_present: bool,
    bundled_node: Option<String>,
    updater_ready: bool,
    titlebar_preview: bool,
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
                        "language_bridge_and_reload": true,
                        "language_smoke_persistence_isolated": true,
                        "daemon_healthy": report.online,
                        "live_ui_restored": report.online,
                        "remote_ipc_denied": report.online,
                        "page_update_bridge": report.online,
                        "titlebar_preview": report.titlebar_preview,
                        "launch_agent_plist_present": report.plist_present,
                        "service_install_enabled": !report.plist_present,
                        "bundled_node": report.bundled_node,
                        "updater_ready": report.updater_ready,
                        "update_menu_rendered": true,
                        "tray_inline_update_progress": true,
                        "tray_settings_navigation": report.online,
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
    let locale = language_view(app).locale;
    wait_for(
        "Install Background Service is enabled exactly when no plist exists",
        || {
            items.install.is_enabled().ok() == Some(!plist_present)
                && items.install.text().ok().as_deref() == Some(locale.text(Text::InstallService))
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
    let current = app.package_info().version.to_string();
    let install_title = locale.format(Text::InstallVersion, &[("version", "v0.0.0-smoke")]);
    let update_title = locale.format(Text::UpdateVersion, &[("version", "v0.0.0-smoke")]);
    let progress_title = Status::Downloading(Some(42)).text(locale);
    if menu.install_shown() || !menu.check.is_enabled().unwrap_or(false) {
        return Err("Update items are not in their initial state".into());
    }
    menu.render(
        app,
        Status::Available("0.0.0-smoke".into()),
        Some("0.0.0-smoke"),
        false,
    );
    wait_for(
        "available update stays reachable inside the native submenu",
        || {
            menu.install_shown()
                && menu.install.text().ok().as_deref() == Some(install_title.as_str())
                && menu.menu.text().ok().as_deref() == Some(update_title.as_str())
        },
    )?;
    menu.render(
        app,
        Status::Downloading(Some(42)),
        Some("0.0.0-smoke"),
        true,
    );
    wait_for(
        "tray shows inline progress and blocks duplicate update actions",
        || {
            menu.menu.text().ok().as_deref() == Some(progress_title.as_str())
                && menu.install_shown()
                && !menu.check.is_enabled().unwrap_or(true)
                && !menu.install.is_enabled().unwrap_or(true)
        },
    )?;
    menu.render(app, Status::Version(current), None, false);
    wait_for(
        "completed update restores the submenu without an install action",
        || {
            !menu.install_shown()
                && menu.menu.text().ok().as_deref() == Some(locale.text(Text::SoftwareUpdates))
                && menu.check.is_enabled().unwrap_or(false)
        },
    )?;
    Ok(Report {
        online: false,
        plist_present,
        bundled_node,
        updater_ready,
        titlebar_preview: false,
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

    // A worktree preview smoke must not query or display the installed daemon's UI.
    let health = if preview_url().is_some() {
        Err("Isolated worktree preview".into())
    } else {
        check_health(&health_client().map_err(|error| error.to_string())?)
    };
    let online = health.is_ok();
    if online {
        render_health(app, items, &health);
        wait_for_live_ui(&window)?;
        check_ipc_denied(&window)?;
        check_update_bridge(&window)?;
        open_settings(app, false);
        wait_for(
            "tray Settings shortcut opens the existing local settings page",
            || {
                evaluate(&window, "location.hash === '#/settings/general' && !!document.querySelector('#settings-view:not([hidden])')").unwrap_or(false)
            },
        )?;
        open_settings(app, true);
        wait_for("tray update details opens About", || {
            evaluate(&window, "location.hash === '#/settings/about'").unwrap_or(false)
        })?;
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
        loaded && evaluate(&window, "document.querySelector('h1')?.textContent === (document.documentElement.lang === 'zh-CN' ? '正在等待本机服务' : 'Waiting for the local service') && document.querySelector('.mark')?.naturalWidth > 0").unwrap_or(false)
    })?;
    check_ipc_denied(&window)?;
    check_language_bridge(&window, items)?;
    render_health(app, items, &health);
    if online {
        wait_for_live_ui(&window)?;
    }
    report.online = online;
    if let Some(url) = preview_url() {
        check_titlebar_preview(&window, url)?;
        report.titlebar_preview = true;
    }
    capture_tray(app, items)?;
    Ok(report)
}

/// An opt-in, debug-only pause for an external driver to inspect the actual macOS menu.
/// Appearance applies to this test process only, without changing the user's system settings.
fn capture_tray(app: &AppHandle, items: &TrayItems) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let Ok(milliseconds) = std::env::var("NOOTIFY_SMOKE_TRAY_CAPTURE_MS")
        .unwrap_or_default()
        .parse::<u64>()
    else {
        return Ok(());
    };
    match std::env::var("NOOTIFY_SMOKE_TRAY_THEME").as_deref() {
        Ok("light") => app.set_theme(Some(tauri::Theme::Light)),
        Ok("dark") => app.set_theme(Some(tauri::Theme::Dark)),
        _ => {}
    }
    if std::env::var("NOOTIFY_SMOKE_TRAY_PROGRESS").as_deref() == Ok("1") {
        items.update.render(
            app,
            Status::Downloading(Some(42)),
            Some("0.0.0-smoke"),
            true,
        );
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window.hide().map_err(|error| error.to_string())?;
    }
    let rect = app
        .tray_by_id(TRAY_ID)
        .ok_or("Tray missing")?
        .rect()
        .map_err(|error| error.to_string())?
        .ok_or("Tray rectangle missing")?;
    let scale = app
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("Primary monitor missing")?
        .scale_factor();
    let position = rect.position.to_logical::<f64>(scale);
    let size = rect.size.to_logical::<f64>(scale);
    let root = items
        .menu
        .items()
        .map_err(|error| error.to_string())?
        .iter()
        .map(|item| item.id().as_ref().to_string())
        .collect::<Vec<_>>();
    println!(
        "{}",
        json!({
            "capture": "tray-ready", "pid": std::process::id(),
            "x": position.x, "y": position.y, "width": size.width, "height": size.height,
            "root_items": root,
        })
    );
    thread::sleep(Duration::from_millis(milliseconds.min(30000)));
    Ok(())
}

/// Exercise the real worktree UI and native navigation bridge with update workers disabled.
fn check_titlebar_preview(window: &WebviewWindow, url: tauri::Url) -> Result<(), String> {
    window.navigate(url).map_err(|error| error.to_string())?;
    wait_for("worktree titlebar loaded", || {
        evaluate(window, "document.documentElement.hasAttribute('data-nootify-desktop') && !!document.querySelector('.titlebar #update-action') && ['Live', '实时更新'].includes(document.querySelector('#connection')?.textContent)").unwrap_or(false)
    })?;
    check_ipc_denied(window)?;
    let mut update = UpdateView {
        phase: Phase::Available,
        version: Some("0.0.0-smoke".into()),
        ..UpdateView::idle(window.app_handle().package_info().version.to_string())
    };
    window
        .eval(update.script())
        .map_err(|error| error.to_string())?;
    window
        .eval("window.__nootifySmokeUpdateButton = document.querySelector('#update-action');")
        .map_err(|error| error.to_string())?;
    wait_for("update action is in the title row", || {
        evaluate(window, "!document.querySelector('#update-action').hidden && document.querySelector('.titlebar').getBoundingClientRect().height === 52 && document.querySelector('#logs-view').getBoundingClientRect().top === 52").unwrap_or(false)
    })?;
    let before = window
        .state::<NativeState>()
        .page_requests
        .load(Ordering::SeqCst);
    window
        .eval("document.querySelector('#update-action').click()")
        .map_err(|error| error.to_string())?;
    wait_for(
        "titlebar update click reaches native code without navigating",
        || {
            window
                .state::<NativeState>()
                .page_requests
                .load(Ordering::SeqCst)
                > before
                && evaluate(
                    window,
                    "!!document.querySelector('.titlebar #update-action')",
                )
                .unwrap_or(false)
        },
    )?;
    update.phase = Phase::Downloading;
    update.received = 42;
    update.total = Some(100);
    window
        .eval(update.script())
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(640.0, 420.0))
        .map_err(|error| error.to_string())?;
    wait_for(
        "compact desktop titlebar keeps progress and content aligned",
        || {
            evaluate(window, "(() => { const header = document.querySelector('.titlebar').getBoundingClientRect(); const brand = document.querySelector('.brand').getBoundingClientRect(); const status = document.querySelector('#update-action'); return innerWidth === 640 && header.y === 0 && header.height === 52 && brand.x >= 90 && Math.abs(brand.y + brand.height / 2 - 26) < 1 && status === window.__nootifySmokeUpdateButton && status.tagName === 'BUTTON' && ['Downloading 42%', '下载中 42%'].includes(status.textContent.trim()) && status.getBoundingClientRect().height === 28 && status.getBoundingClientRect().width === (document.documentElement.lang === 'en' ? 164 : 136) && !status.hidden && !document.querySelector('.titlebar progress') && document.documentElement.scrollWidth === innerWidth; })()").unwrap_or(false)
        },
    )?;
    // Optional bounded pause lets an external native driver capture and drag this settled window.
    if let Ok(milliseconds) = std::env::var("NOOTIFY_SMOKE_CAPTURE_DELAY_MS")
        .unwrap_or_default()
        .parse::<u64>()
    {
        thread::sleep(Duration::from_millis(milliseconds.min(5000)));
    }
    // Double-clicking empty title-row space zooms, while the update button above remained clickable.
    window.eval("document.querySelector('.titlebar').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2 }))").map_err(|error| error.to_string())?;
    wait_for("titlebar double-click zooms the native window", || {
        window.is_maximized().unwrap_or(false)
    })?;
    window.unmaximize().map_err(|error| error.to_string())?;
    window
        .eval("document.querySelector('#update-action').click()")
        .map_err(|error| error.to_string())?;
    wait_for("titlebar status opens update details", || {
        evaluate(window, "location.hash === '#/settings/about' && document.querySelector('#update-status').textContent.includes('42%')").unwrap_or(false)
    })
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
        loaded && evaluate(window, "(() => { const one = values => new Set(values.map(Math.round)).size === 1; const rows = [...document.querySelectorAll('#logs-table .row')].map(row => row.getBoundingClientRect().height); const lines = [...document.querySelectorAll('.sidebar-foot .status-line')].filter(line => line.offsetParent).map(line => line.getBoundingClientRect()); const gaps = lines.slice(1).map((line, index) => line.top - lines[index].bottom); return rows.length > 1 && one(rows) && gaps.length > 1 && one(gaps) && ['Live', '实时更新'].includes(document.querySelector('#connection')?.textContent) && document.querySelector('#error')?.hidden === true; })()").unwrap_or(false)
    })
}

fn evaluate(window: &WebviewWindow, expression: &str) -> Result<bool, String> {
    evaluate_value(window, expression).map(|value| value == "true")
}

fn evaluate_value(window: &WebviewWindow, expression: &str) -> Result<String, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(expression, move |result| {
            let _ = sender.try_send(result);
        })
        .map_err(|error| error.to_string())?;
    let result = receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    Ok(result)
}

/// Exercises the real navigation policy, immediate native relabeling, the CSP-locked fallback,
/// and document-start state after reload. Smoke preferences are intentionally never persisted.
fn check_language_bridge(window: &WebviewWindow, items: &TrayItems) -> Result<(), String> {
    let app = window.app_handle();
    let original = language_view(app).preference;
    window.eval("window.addEventListener('nootify-language', event => { window.__nootifySmokeLanguage = JSON.stringify(event.detail); })").map_err(|error| error.to_string())?;
    for (path, preference, locale) in [
        ("en", Preference::English, Locale::English),
        (
            "system",
            Preference::System,
            crate::language::system_locale(),
        ),
        ("zh-CN", Preference::Chinese, Locale::Chinese),
    ] {
        let expected =
            serde_json::to_string(&crate::language::LanguageView::new(preference, locale)).unwrap();
        window
            .eval(format!("location.href = 'nootify://language/{path}'"))
            .map_err(|error| error.to_string())?;
        wait_for(
            "language request updates the page and tray without navigating",
            || {
                language_view(app).preference == preference
                && items.open.text().ok().as_deref() == Some(locale.text(Text::Open))
                && evaluate(window, &format!("window.__nootifySmokeLanguage === {} && document.documentElement.lang === {}", json!(expected), json!(if locale == Locale::Chinese { "zh-CN" } else { "en" }))).unwrap_or(false)
            },
        )?;
    }
    // A probe after the production initialization scripts observes state before page JS or replay.
    window.with_webview(|platform| {
        use objc2::{MainThreadMarker, MainThreadOnly};
        use objc2_foundation::NSString;
        use objc2_web_kit::{WKUserContentController, WKUserScript, WKUserScriptInjectionTime};
        let mtm = MainThreadMarker::new().expect("main thread");
        // SAFETY: Tauri supplies Wry's live controller on the owning main thread.
        unsafe {
            let controller = &*platform.controller().cast::<WKUserContentController>();
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(mtm),
                &NSString::from_str("window.__nootifySmokeDocumentLanguage = JSON.stringify(window.__NOOTIFY_LANGUAGE__); window.__nootifySmokeCsp = []; document.addEventListener('securitypolicyviolation', event => { window.__nootifySmokeCsp.push({directive:event.effectiveDirective,uri:event.blockedURI}); });"),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            );
            controller.addUserScript(&script);
        }
    }).map_err(|error| error.to_string())?;
    window
        .eval("location.reload()")
        .map_err(|error| error.to_string())?;
    wait_for(
        "reloaded document starts in the saved native language",
        || {
            evaluate(window, "window.__nootifySmokeDocumentLanguage === JSON.stringify({preference:'zh-CN',locale:'zh-CN'}) && document.documentElement.lang === 'zh-CN' && document.querySelector('h1')?.textContent === '正在等待本机服务'").unwrap_or(false)
        },
    ).map_err(|error| format!("{error}: {}", evaluate_value(window, "JSON.stringify({initial:window.__nootifySmokeDocumentLanguage,current:window.__NOOTIFY_LANGUAGE__,lang:document.documentElement.lang,heading:document.querySelector('h1')?.textContent,url:location.href})").unwrap_or_default()))?;
    if !evaluate(window, "window.__nootifySmokeCsp?.length === 0")? {
        return Err(format!(
            "Fallback CSP violations: {}",
            evaluate_value(window, "JSON.stringify(window.__nootifySmokeCsp)")?
        ));
    }
    check_ipc_denied(window)?;
    crate::change_language(app, original);
    Ok(())
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
