//! Updates from GitHub Releases, driven from Rust: the webview has no updater permissions. Checks
//! and installs run on one worker thread, never on the main thread. The tray and the page show the
//! same state. The page receives it as a DOM event and asks for an action by navigating to
//! `nootify://update/…`, which the window's policy cancels, so it never needs IPC.
use std::{
    collections::hash_map::RandomState,
    hash::BuildHasher,
    sync::{
        mpsc::{Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    AppHandle, Manager, Url, Wry,
};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{
    language::{Locale, Text},
    service::{menu_text, BackgroundService, BundledService},
    NativeState, MAIN_WINDOW,
};

pub const CHECK_ID: &str = "check_update";
pub const INSTALL_ID: &str = "install_update";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const FIRST_CHECK_JITTER: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_JITTER: Duration = Duration::from_secs(30 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(15 * 60);
const RETRY_JITTER: Duration = Duration::from_secs(5 * 60);
/// Re-read the wall clock at least this often, so the interval also elapses while the Mac sleeps.
const TICK: Duration = Duration::from_secs(60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateRequest {
    Check,
    Install,
}

/// The two things the tray can already do are all a page may ask for.
pub fn page_request(url: &Url) -> Option<UpdateRequest> {
    if url.scheme() != "nootify" || url.host_str() != Some("update") {
        return None;
    }
    match url.path() {
        "/check" => Some(UpdateRequest::Check),
        "/install" => Some(UpdateRequest::Install),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Installing,
    Restarting,
    Failed,
}

/// What the page shows; mirrors `UpdateView` in src/ui-app.ts.
#[derive(Clone, Debug, Serialize)]
pub struct UpdateView {
    pub phase: Phase,
    pub current: String,
    pub version: Option<String>,
    pub received: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub checked_at: Option<u64>,
}

impl UpdateView {
    pub fn idle(current: String) -> Self {
        Self {
            phase: Phase::Idle,
            current,
            version: None,
            received: 0,
            total: None,
            error: None,
            checked_at: None,
        }
    }

    /// An event rather than a call, so it is harmless in a document without a listener.
    pub fn script(&self) -> String {
        let detail = serde_json::to_string(self).expect("update state serializes");
        format!("window.dispatchEvent(new CustomEvent('nootify-update', {{ detail: {detail} }}))")
    }
}

/// Keeps the latest state for the next page load, and shows it in the current one.
fn publish(app: &AppHandle, view: &UpdateView) {
    let script = view.script();
    *app.state::<NativeState>()
        .update_script
        .lock()
        .expect("update state") = script.clone();
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.eval(script);
    }
}

/// One step per percent, or per MiB while the size is unknown, so a download is at most a few
/// hundred page updates however small its chunks are.
fn progress_step(received: u64, total: Option<u64>) -> u64 {
    match total {
        Some(total) => (received * 100 / total).min(100),
        None => received >> 20,
    }
}

/// Keep semantic state, rather than translated strings, so an in-flight update changes language
/// immediately without restarting the worker or losing progress. Full errors stay in Settings > About.
#[derive(Clone, Debug)]
pub enum Status {
    Version(String),
    Checking,
    Available(String),
    Current(String),
    Downloading(Option<u64>),
    Installing,
    Restarting,
    CheckFailed,
    InstallFailed,
}

impl Status {
    pub fn text(&self, locale: Locale) -> String {
        let (key, version) = match self {
            Self::Version(version) => (Text::CurrentVersion, Some(version)),
            Self::Available(version) => (Text::UpdateAvailable, Some(version)),
            Self::Current(version) => (Text::UpToDate, Some(version)),
            Self::Checking => (Text::CheckingUpdate, None),
            Self::Downloading(Some(percent)) => {
                return locale.format(Text::DownloadPercent, &[("percent", &percent.to_string())])
            }
            Self::Downloading(None) => (Text::Downloading, None),
            Self::Installing => (Text::Installing, None),
            Self::Restarting => (Text::Restarting, None),
            Self::CheckFailed => (Text::CheckFailed, None),
            Self::InstallFailed => (Text::InstallFailed, None),
        };
        version.map_or_else(
            || locale.text(key).into(),
            |version| locale.format(key, &[("version", &tag(version))]),
        )
    }
}

#[derive(Clone)]
struct MenuState {
    status: Status,
    available: Option<String>,
    busy: bool,
}

#[derive(Clone)]
pub struct UpdateMenu {
    tray: Menu<Wry>,
    pub menu: Submenu<Wry>,
    pub status: MenuItem<Wry>,
    pub check: MenuItem<Wry>,
    pub install: MenuItem<Wry>,
    pub about: MenuItem<Wry>,
    state: Arc<Mutex<MenuState>>,
}

impl UpdateMenu {
    pub fn new(
        tray: Menu<Wry>,
        menu: Submenu<Wry>,
        status: MenuItem<Wry>,
        check: MenuItem<Wry>,
        install: MenuItem<Wry>,
        about: MenuItem<Wry>,
        current: String,
    ) -> Self {
        Self {
            tray,
            menu,
            status,
            check,
            install,
            about,
            state: Arc::new(Mutex::new(MenuState {
                status: Status::Version(current),
                available: None,
                busy: false,
            })),
        }
    }

    pub fn render(&self, app: &AppHandle, status: Status, available: Option<&str>, busy: bool) {
        *self.state.lock().expect("update menu state") = MenuState {
            status,
            available: available.map(str::to_owned),
            busy,
        };
        self.relocalize(app);
    }

    pub fn relocalize(&self, app: &AppHandle) {
        let menu = self.clone();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Snapshot on the main thread: queued worker renders cannot restore an old locale.
            let state = menu.state.lock().expect("update menu state").clone();
            menu.apply(crate::language_view(&handle).locale, &state);
        });
    }

    fn apply(&self, locale: Locale, state: &MenuState) {
        let status = state.status.text(locale);
        let _ = self.menu.set_text(locale.text(Text::SoftwareUpdates));
        let _ = self.status.set_text(menu_text(&status));
        let _ = self.check.set_text(locale.text(Text::CheckUpdate));
        let _ = self.about.set_text(locale.text(Text::UpdateDetails));
        let _ = self.check.set_enabled(!state.busy);
        let _ = self.install.set_enabled(!state.busy);
        match &state.available {
            Some(version) => {
                let title = if state.busy {
                    menu_text(&status)
                } else {
                    locale.format(Text::InstallVersion, &[("version", &tag(version))])
                };
                let _ = self.install.set_text(title);
                if !self.install_shown() {
                    if let Some(index) = self.position("updates") {
                        let _ = self.tray.insert(&self.install, index);
                    }
                }
            }
            None => {
                let _ = self.install.set_text(locale.text(Text::InstallUpdate));
                if self.install_shown() {
                    let _ = self.tray.remove(&self.install);
                }
            }
        }
    }

    pub fn install_shown(&self) -> bool {
        self.position(INSTALL_ID).is_some()
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.tray
            .items()
            .ok()?
            .iter()
            .position(|item| item.id().as_ref() == id)
    }
}

pub fn tag(version: &str) -> String {
    if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    }
}

pub fn spawn(
    app: AppHandle,
    requests: Receiver<UpdateRequest>,
    menu: UpdateMenu,
    agent: BackgroundService,
    bundled: Option<BundledService>,
) {
    let current = app.package_info().version.to_string();
    #[cfg(target_os = "windows")]
    let _ = (agent, bundled); // NSIS owns service replacement and relaunch on Windows.
    let worker = Worker {
        app,
        menu,
        #[cfg(target_os = "macos")]
        agent,
        #[cfg(target_os = "macos")]
        bundled,
        current,
        pending: None,
        checked_at: None,
    };
    thread::spawn(move || worker.run(requests));
}

struct Worker {
    app: AppHandle,
    menu: UpdateMenu,
    #[cfg(target_os = "macos")]
    agent: BackgroundService,
    #[cfg(target_os = "macos")]
    bundled: Option<BundledService>,
    current: String,
    pending: Option<Update>,
    checked_at: Option<u64>,
}

/// Wall-clock deadlines include sleep time. Each new deadline gets independent jitter so
/// machines launched together do not keep checking GitHub together on subsequent intervals.
struct CheckSchedule {
    next: SystemTime,
    delay: Duration,
}

impl CheckSchedule {
    fn new(now: SystemTime, base: Duration, spread: Duration) -> Self {
        // The standard library seeds each RandomState independently; no extra RNG is needed
        // for timing jitter. This value is never used for security-sensitive randomness.
        let delay = jittered(base, spread, RandomState::new().hash_one(()));
        Self {
            next: now + delay,
            delay,
        }
    }

    fn after_check(now: SystemTime, succeeded: bool) -> Self {
        if succeeded {
            Self::new(now, CHECK_INTERVAL, CHECK_JITTER)
        } else {
            Self::new(now, RETRY_INTERVAL, RETRY_JITTER)
        }
    }

    fn remaining(&mut self, now: SystemTime) -> Duration {
        let remaining = until(now, self.next);
        if remaining > self.delay {
            // A backwards clock adjustment must not postpone checks indefinitely.
            self.next = now + self.delay;
            self.delay
        } else {
            remaining
        }
    }
}

fn jittered(base: Duration, spread: Duration, sample: u64) -> Duration {
    let spread_ms = spread.as_millis() as u64;
    base - spread + Duration::from_millis(sample % (2 * spread_ms + 1))
}

impl Worker {
    fn run(mut self, requests: Receiver<UpdateRequest>) {
        // Development builds have no app bundle to replace; they check only when asked.
        let mut next_check = (!cfg!(dev))
            .then(|| CheckSchedule::new(SystemTime::now(), FIRST_CHECK, FIRST_CHECK_JITTER));
        loop {
            let now = SystemTime::now();
            let wait = next_check
                .as_mut()
                .map_or(TICK, |next| next.remaining(now).min(TICK));
            match requests.recv_timeout(wait) {
                Ok(UpdateRequest::Check) => {
                    let succeeded = self.check();
                    next_check = next_check
                        .map(|_| CheckSchedule::after_check(SystemTime::now(), succeeded));
                }
                Ok(UpdateRequest::Install) => self.install(),
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(next) = &mut next_check {
                        if next.remaining(SystemTime::now()).is_zero() {
                            let succeeded = self.check();
                            *next = CheckSchedule::after_check(SystemTime::now(), succeeded);
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    fn show(&self, status: Status, busy: bool) {
        let available = self.pending.as_ref().map(|update| update.version.as_str());
        self.menu.render(&self.app, status, available, busy);
    }

    fn view(&self, phase: Phase) -> UpdateView {
        UpdateView {
            phase,
            version: self.pending.as_ref().map(|update| update.version.clone()),
            checked_at: self.checked_at,
            ..UpdateView::idle(self.current.clone())
        }
    }

    fn check(&mut self) -> bool {
        self.show(Status::Checking, true);
        publish(&self.app, &self.view(Phase::Checking));
        let result = self
            .app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .build()
            .and_then(|updater| tauri::async_runtime::block_on(updater.check()));
        match result {
            Ok(Some(update)) => {
                let status = Status::Available(update.version.clone());
                self.pending = Some(update);
                self.checked_at = Some(now_ms());
                self.show(status, false);
                publish(&self.app, &self.view(Phase::Available));
                true
            }
            Ok(None) => {
                self.pending = None;
                self.checked_at = Some(now_ms());
                self.show(Status::Current(self.current.clone()), false);
                publish(&self.app, &self.view(Phase::Current));
                true
            }
            // A previously found update stays installable.
            Err(error) => {
                self.show(Status::CheckFailed, false);
                let phase = if self.pending.is_some() {
                    Phase::Available
                } else {
                    Phase::Failed
                };
                let view = UpdateView {
                    error: Some(error.to_string()),
                    ..self.view(phase)
                };
                publish(&self.app, &view);
                false
            }
        }
    }

    fn install(&mut self) {
        let Some(mut update) = self.pending.clone() else {
            return;
        };
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        let menu = self.menu.clone();
        let show = |status: Status| menu.render(&self.app, status, Some(&update.version), true);
        show(Status::Downloading(None));
        let app = &self.app;
        let mut progress = self.view(Phase::Downloading);
        let installing = self.view(Phase::Installing);
        publish(app, &progress);
        let mut shown = None;
        let result = tauri::async_runtime::block_on(update.download_and_install(
            |chunk, total| {
                progress.received += chunk as u64;
                progress.total = total.filter(|total| *total > 0);
                let step = progress_step(progress.received, progress.total);
                if shown != Some(step) {
                    shown = Some(step);
                    if progress.total.is_some() {
                        show(Status::Downloading(Some(step)));
                    }
                    publish(app, &progress);
                }
            },
            || {
                show(Status::Installing);
                publish(app, &installing);
            },
        ));
        if let Err(error) = result {
            self.show(Status::InstallFailed, false);
            // Still pending: the page offers the same action again.
            let view = UpdateView {
                error: Some(error.to_string()),
                ..self.view(Phase::Available)
            };
            publish(&self.app, &view);
            return;
        }
        self.show(Status::Restarting, true);
        publish(&self.app, &self.view(Phase::Restarting));
        #[cfg(target_os = "windows")]
        {
            // tauri-plugin-updater 2.14 exits after launching NSIS with /UPDATE /R.
            // If a future plugin returns, still exit: only NSIS may relaunch the installed
            // executable and its task. current_exe() may name an old, renamed binary.
            self.app.exit(0);
        }
        #[cfg(target_os = "macos")]
        {
            // macOS replaces the app in place, so restart its owned daemon before relaunch.
            if let Some(bundled) = &self.bundled {
                if let Err(error) = self.agent.restart_if_runs(&bundled.node) {
                    eprintln!(
                        "Cannot restart {} after the update: {error}",
                        crate::service::LABEL
                    );
                }
            }
            self.app.restart();
        }
    }
}

fn until(now: SystemTime, then: SystemTime) -> Duration {
    then.duration_since(now).unwrap_or(Duration::ZERO)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_can_only_ask_for_a_check_or_an_install() {
        let request = |url: &str| page_request(&Url::parse(url).unwrap());
        assert_eq!(
            request("nootify://update/check"),
            Some(UpdateRequest::Check)
        );
        assert_eq!(
            request("nootify://update/install"),
            Some(UpdateRequest::Install)
        );
        for other in [
            "nootify://update/",
            "nootify://update/restart",
            "nootify://other/check",
            "https://update/check",
            "http://127.0.0.1:9417/#/settings/about",
        ] {
            assert_eq!(request(other), None, "{other}");
        }
    }

    #[test]
    fn page_state_is_one_event_with_the_fields_the_page_reads() {
        let view = UpdateView {
            phase: Phase::Downloading,
            version: Some("0.2.0".into()),
            received: 5,
            total: Some(10),
            ..UpdateView::idle("0.1.1".into())
        };
        let script = view.script();
        let detail = script
            .strip_prefix("window.dispatchEvent(new CustomEvent('nootify-update', { detail: ")
            .and_then(|rest| rest.strip_suffix(" }))"))
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(detail).unwrap();
        assert_eq!(value["phase"], "downloading");
        assert_eq!(value["current"], "0.1.1");
        assert_eq!(value["version"], "0.2.0");
        assert_eq!(
            (value["received"].as_u64(), value["total"].as_u64()),
            (Some(5), Some(10))
        );
    }

    #[test]
    fn update_statuses_can_change_language_without_losing_progress_or_version() {
        assert_eq!(
            Status::Downloading(Some(42)).text(Locale::English),
            "Downloading 42%"
        );
        assert_eq!(
            Status::Downloading(Some(42)).text(Locale::Chinese),
            "下载中 42%"
        );
        assert_eq!(
            Status::Available("0.2.0".into()).text(Locale::English),
            "Update available: v0.2.0"
        );
        assert_eq!(
            Status::Available("v0.2.0".into()).text(Locale::Chinese),
            "可更新至 v0.2.0"
        );
        for status in [
            Status::Checking,
            Status::Downloading(None),
            Status::Installing,
            Status::Restarting,
            Status::CheckFailed,
            Status::InstallFailed,
        ] {
            let english = status.text(Locale::English);
            assert!(english.is_ascii() || english.ends_with('…'), "{english}");
            assert_ne!(english, status.text(Locale::Chinese));
        }
    }

    #[test]
    fn progress_steps_stay_bounded() {
        assert_eq!(progress_step(50, Some(200)), 25);
        assert_eq!(progress_step(300, Some(200)), 100);
        assert_eq!(progress_step(3 << 20, None), 3);
    }

    #[test]
    fn versions_are_shown_with_one_v_prefix() {
        assert_eq!(tag("0.2.0"), "v0.2.0");
        assert_eq!(tag("v0.2.0"), "v0.2.0");
    }

    #[test]
    fn jitter_bounds_cover_startup_regular_checks_and_retries() {
        for (base, spread) in [
            (FIRST_CHECK, FIRST_CHECK_JITTER),
            (CHECK_INTERVAL, CHECK_JITTER),
            (RETRY_INTERVAL, RETRY_JITTER),
        ] {
            let width = 2 * spread.as_millis() as u64 + 1;
            assert_eq!(jittered(base, spread, 0), base - spread);
            assert_eq!(jittered(base, spread, width - 1), base + spread);
            assert_eq!(jittered(base, spread, width), base - spread);
            for sample in [1, width / 2, u64::MAX] {
                let delay = jittered(base, spread, sample);
                assert!(delay >= base - spread && delay <= base + spread);
            }
        }
    }

    #[test]
    fn failed_checks_retry_soon_and_success_restores_the_regular_interval() {
        let now = SystemTime::now();
        for (succeeded, base, spread) in [
            (false, RETRY_INTERVAL, RETRY_JITTER),
            (true, CHECK_INTERVAL, CHECK_JITTER),
        ] {
            let mut schedule = CheckSchedule::after_check(now, succeeded);
            let delay = schedule.remaining(now);
            assert!(delay >= base - spread && delay <= base + spread);
            assert!(!schedule
                .remaining(now + delay - Duration::from_millis(1))
                .is_zero());
            assert!(schedule.remaining(now + delay).is_zero());
        }
    }

    #[test]
    fn checks_are_due_after_sleep_without_waiting_another_interval() {
        let now = SystemTime::now();
        let mut schedule = CheckSchedule::new(now, CHECK_INTERVAL, CHECK_JITTER);
        assert!(schedule
            .remaining(now + CHECK_INTERVAL + CHECK_JITTER)
            .is_zero());
    }

    #[test]
    fn backwards_clock_changes_rebase_to_one_scheduled_delay() {
        let now = SystemTime::now();
        let mut schedule = CheckSchedule::new(now, RETRY_INTERVAL, RETRY_JITTER);
        let delay = schedule.delay;
        let earlier = now - Duration::from_secs(24 * 60 * 60);
        assert_eq!(schedule.remaining(earlier), delay);
        assert!(schedule.remaining(earlier + delay).is_zero());
    }

    #[test]
    fn waits_never_go_negative() {
        let now = SystemTime::now();
        assert_eq!(until(now, now - Duration::from_secs(5)), Duration::ZERO);
        assert_eq!(until(now, now + FIRST_CHECK), FIRST_CHECK);
    }
}
