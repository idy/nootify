//! Updates from GitHub Releases, driven from Rust and the tray only: the webview has no updater
//! permissions. Checks and installs run on one worker thread, never on the main thread.
use std::{
    sync::mpsc::{Receiver, RecvTimeoutError},
    thread,
    time::{Duration, SystemTime},
};

use tauri::{
    menu::{Menu, MenuItem},
    AppHandle, Wry,
};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::service::{menu_text, BundledService, LaunchAgent};

pub const CHECK_ID: &str = "check_update";
pub const INSTALL_ID: &str = "install_update";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Re-read the wall clock at least this often, so the interval also elapses while the Mac sleeps.
const TICK: Duration = Duration::from_secs(60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub enum UpdateRequest {
    Check,
    Install,
}

/// The tray's update section: a status line, 检查更新, and 安装更新 vX.Y.Z, which is in the menu
/// only while an update is available.
#[derive(Clone)]
pub struct UpdateMenu {
    menu: Menu<Wry>,
    pub status: MenuItem<Wry>,
    pub check: MenuItem<Wry>,
    pub install: MenuItem<Wry>,
}

impl UpdateMenu {
    pub fn new(
        menu: Menu<Wry>,
        status: MenuItem<Wry>,
        check: MenuItem<Wry>,
        install: MenuItem<Wry>,
    ) -> Self {
        Self {
            menu,
            status,
            check,
            install,
        }
    }

    pub fn render(&self, status: &str, available: Option<&str>, busy: bool) {
        let _ = self.status.set_text(menu_text(status));
        let _ = self.check.set_enabled(!busy);
        let _ = self.install.set_enabled(!busy);
        match available {
            Some(version) => {
                let _ = self.install.set_text(format!("安装更新 {}", tag(version)));
                if !self.install_shown() {
                    if let Some(index) = self.position(CHECK_ID) {
                        let _ = self.menu.insert(&self.install, index + 1);
                    }
                }
            }
            None if self.install_shown() => {
                let _ = self.menu.remove(&self.install);
            }
            None => {}
        }
    }

    pub fn install_shown(&self) -> bool {
        self.position(INSTALL_ID).is_some()
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.menu
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
    agent: LaunchAgent,
    bundled: Option<BundledService>,
) {
    let current = app.package_info().version.to_string();
    let worker = Worker {
        app,
        menu,
        agent,
        bundled,
        current,
        pending: None,
    };
    thread::spawn(move || worker.run(requests));
}

struct Worker {
    app: AppHandle,
    menu: UpdateMenu,
    agent: LaunchAgent,
    bundled: Option<BundledService>,
    current: String,
    pending: Option<Update>,
}

impl Worker {
    fn run(mut self, requests: Receiver<UpdateRequest>) {
        // Development builds have no app bundle to replace; they check only when asked.
        let mut next_check = (!cfg!(dev)).then(|| SystemTime::now() + FIRST_CHECK);
        loop {
            let now = SystemTime::now();
            let wait = next_check.map_or(TICK, |next| until(now, next).min(TICK));
            match requests.recv_timeout(wait) {
                Ok(UpdateRequest::Check) => {
                    self.check();
                    next_check = next_check.map(|_| SystemTime::now() + CHECK_INTERVAL);
                }
                Ok(UpdateRequest::Install) => self.install(),
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(next) = next_check {
                        let now = SystemTime::now();
                        if until(now, next).is_zero() {
                            self.check();
                            next_check = Some(SystemTime::now() + CHECK_INTERVAL);
                        } else if until(now, next) > CHECK_INTERVAL {
                            // The clock moved backwards; do not wait longer than one interval.
                            next_check = Some(now + CHECK_INTERVAL);
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    fn show(&self, status: &str, busy: bool) {
        let available = self.pending.as_ref().map(|update| update.version.as_str());
        self.menu.render(status, available, busy);
    }

    fn check(&mut self) {
        self.show("更新：正在检查…", true);
        let result = self
            .app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .build()
            .and_then(|updater| tauri::async_runtime::block_on(updater.check()));
        match result {
            Ok(Some(update)) => {
                let status = format!("更新：发现 {}", tag(&update.version));
                self.pending = Some(update);
                self.show(&status, false);
            }
            Ok(None) => {
                self.pending = None;
                self.show(&format!("更新：已是最新 {}", tag(&self.current)), false);
            }
            // A previously found update stays installable.
            Err(error) => self.show(&format!("检查更新失败：{error}"), false),
        }
    }

    fn install(&mut self) {
        let Some(mut update) = self.pending.clone() else {
            return;
        };
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        let version = tag(&update.version);
        let menu = self.menu.clone();
        let show = |status: String| menu.render(&status, Some(&update.version), true);
        show(format!("更新：正在下载 {version}…"));
        let (mut received, mut shown) = (0u64, None);
        let result = tauri::async_runtime::block_on(update.download_and_install(
            |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|total| *total > 0) {
                    let percent = (received * 100 / total).min(100);
                    if shown != Some(percent) {
                        shown = Some(percent);
                        show(format!("更新：正在下载 {version} {percent}%"));
                    }
                }
            },
            || show(format!("更新：正在安装 {version}…")),
        ));
        if let Err(error) = result {
            self.show(&format!("安装更新失败：{error}"), false);
            return;
        }
        self.show(&format!("更新：已安装 {version}，正在重启…"), true);
        // The bundle now holds the new service as well: restart the job if it runs this bundle's
        // Node.js. A failure only delays the new service code until the job next restarts.
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

fn until(now: SystemTime, then: SystemTime) -> Duration {
    then.duration_since(now).unwrap_or(Duration::ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_shown_with_one_v_prefix() {
        assert_eq!(tag("0.2.0"), "v0.2.0");
        assert_eq!(tag("v0.2.0"), "v0.2.0");
    }

    #[test]
    fn waits_never_go_negative() {
        let now = SystemTime::now();
        assert_eq!(until(now, now - Duration::from_secs(5)), Duration::ZERO);
        assert_eq!(until(now, now + FIRST_CHECK), FIRST_CHECK);
    }
}
