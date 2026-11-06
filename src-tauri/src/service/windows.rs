//! The installed per-user Scheduled Task owns the daemon, independently of this window.
use std::{
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

use super::{installer_error, run_with_timeout, BundledService, CommandOutput, JobAction};

// The CLI allows 60 s for serialization plus stop/start health waits, capped at 150 s.
const MANAGEMENT_TIMEOUT: Duration = Duration::from_secs(155);

pub struct BackgroundService {
    home: PathBuf,
    installed: Mutex<Option<(Instant, bool)>>,
}

impl BackgroundService {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            installed: Mutex::new(None),
        }
    }

    /// Task Scheduler is queried off the UI thread and cached between health polls.
    /// An unreadable or unrelated task counts as present, so Install never overwrites it.
    pub fn installed(&self) -> bool {
        if let Some((checked, present)) = *self.installed.lock().expect("task status") {
            if checked.elapsed() < Duration::from_secs(15) {
                return present;
            }
        }
        let result = self.bundle().and_then(|bundled| {
            let output = self.run(&bundled, "service-status", false)?;
            #[derive(serde::Deserialize)]
            struct Status {
                installed: bool,
            }
            serde_json::from_str::<Status>(output.stdout.trim())
                .map(|status| status.installed)
                .map_err(|error| format!("Invalid background service status: {error}"))
        });
        let present = match result {
            Ok(present) => present,
            Err(error) => {
                eprintln!("Cannot inspect Nootify background task: {error}");
                true
            }
        };
        *self.installed.lock().expect("task status") = Some((Instant::now(), present));
        present
    }

    pub fn request(&self, action: JobAction) -> Result<(), String> {
        let bundled = self.bundle()?;
        let command = match action {
            JobAction::Start => "service-start",
            JobAction::Restart => "service-restart",
        };
        self.run(&bundled, command, false).map(|_| ())
    }

    pub fn install(&self, bundled: &BundledService) -> Result<(), String> {
        // The CLI checks the live port, exact task ownership, and registration atomically
        // with the authoritative scheduler state; no cached status authorizes a change.
        self.run(bundled, "service-install", true).map(|_| ())
    }

    fn bundle(&self) -> Result<BundledService, String> {
        BundledService::current()?
            .ok_or_else(|| "development builds do not bundle the service".into())
    }

    fn run(
        &self,
        bundled: &BundledService,
        action: &str,
        install: bool,
    ) -> Result<CommandOutput, String> {
        let mut command = Command::new(&bundled.node);
        command
            .arg(&bundled.cli)
            .arg(action)
            .current_dir(&self.home)
            .env_clear();
        // Preserve only OS/profile variables needed by Node, PowerShell and Task Scheduler.
        // In particular NODE_OPTIONS and ambient provider credentials never enter the daemon.
        for name in [
            "SystemRoot",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "PATH",
            "PATHEXT",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "USERNAME",
            "USERDOMAIN",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env("HOME", &self.home);
        if install {
            let config = self.home.join(".claude.json");
            if config.is_file() {
                command.arg("--mcp-config").arg(config);
            }
        }
        let output = run_with_timeout(command, MANAGEMENT_TIMEOUT)?;
        *self.installed.lock().expect("task status") = None;
        if output.status.success() {
            Ok(output)
        } else {
            Err(installer_error(&output))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn installed_runtime_and_resources_share_the_install_directory() {
        let root = Path::new(r"C:\Users\Example User\AppData\Local\Nootify");
        let bundled = BundledService::locate(&root.join("Nootify.exe")).unwrap();
        assert_eq!(bundled.node, root.join("node.exe"));
        assert_eq!(bundled.cli, root.join("service/dist/src/cli.js"));
    }

    #[test]
    fn windows_health_requires_the_nootify_contract() {
        assert!(super::super::parse_health(
            br#"{"service":"nootify","modules":[{"name":"sessions","status":"ready"}]}"#
        )
        .is_ok());
        assert!(super::super::parse_health(br#"{"service":"other","modules":[]}"#).is_err());
        assert!(super::super::parse_health(br#"{"service":"nootify"}"#).is_err());
    }

    #[test]
    fn windows_management_processes_have_bounded_output_and_runtime() {
        let root = std::env::var_os("SystemRoot").expect("Windows system directory");
        let mut echo = Command::new(PathBuf::from(&root).join("System32/cmd.exe"));
        echo.args(["/D", "/C", "echo out&echo err 1>&2"]);
        let output = run_with_timeout(echo, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.trim(), "out");
        assert_eq!(output.stderr.trim(), "err");

        let mut sleep = Command::new(
            PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        sleep.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let started = Instant::now();
        assert!(run_with_timeout(sleep, Duration::from_millis(300))
            .unwrap_err()
            .contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
