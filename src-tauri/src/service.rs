use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use reqwest::{blocking::Client, redirect::Policy};
use serde::Deserialize;

pub const SERVICE_URL: &str = "http://127.0.0.1:9417/";
pub const LABEL: &str = "dev.idy.nootify.service";
const HEALTH_LIMIT: u64 = 64 * 1024;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ModuleStatus {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Health {
    pub service: String,
    pub modules: Vec<ModuleStatus>,
}

pub fn health_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
}

pub fn check_health(client: &Client) -> Result<Health, String> {
    let response = client
        .get(format!("{SERVICE_URL}health"))
        .send()
        .map_err(|error| format!("Cannot connect: {error}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Health returned HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    response
        .take(HEALTH_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read health: {error}"))?;
    parse_health(&bytes)
}

fn parse_health(bytes: &[u8]) -> Result<Health, String> {
    if bytes.len() > HEALTH_LIMIT as usize {
        return Err("Health response exceeds 64 KiB".into());
    }
    let health: Health = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid health response: {error}"))?;
    if health.service != "nootify" {
        return Err("Port 9417 is not serving Nootify".into());
    }
    Ok(health)
}

pub fn menu_text(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(180).collect()
}

#[derive(Clone, Copy)]
pub enum JobAction {
    Start,
    Restart,
}

impl JobAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => "启动服务",
            Self::Restart => "重启服务",
        }
    }
}

pub struct LaunchAgent {
    uid: u32,
    plist: PathBuf,
}

impl LaunchAgent {
    pub fn new(home: PathBuf) -> Self {
        Self {
            // SAFETY: geteuid has no arguments or memory preconditions.
            uid: unsafe { libc::geteuid() },
            plist: home
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
        }
    }

    pub fn request(&self, action: JobAction) -> Result<(), String> {
        // Never install/rewrite a plist, run Node, or create another receiver.
        let loaded = Command::new("/bin/launchctl")
            .args(["print", &format!("gui/{}/{LABEL}", self.uid)])
            .output()
            .map_err(|error| format!("Cannot inspect launchd: {error}"))?
            .status
            .success();
        if !loaded && !self.plist.is_file() {
            return Err(
                "LaunchAgent is not installed; use the service's launchd-install command first"
                    .into(),
            );
        }
        let output = Command::new("/bin/launchctl")
            .args(operation_args(action, loaded, self.uid, &self.plist))
            .output()
            .map_err(|error| format!("Cannot run launchctl: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "launchctl {}: {}",
                output.status,
                menu_text(&String::from_utf8_lossy(&output.stderr))
            ));
        }
        Ok(())
    }
}

fn operation_args(action: JobAction, loaded: bool, uid: u32, plist: &Path) -> Vec<OsString> {
    if !loaded {
        return vec![
            "bootstrap".into(),
            format!("gui/{uid}").into(),
            plist.into(),
        ];
    }
    let mut args = vec!["kickstart".into()];
    if matches!(action, JobAction::Restart) {
        args.push("-k".into());
    }
    args.push(format!("gui/{uid}/{LABEL}").into());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_requires_our_service_and_module_contract() {
        let value = parse_health(br#"{"ok":true,"service":"nootify","modules":[{"name":"lark","status":"disabled"}]}"#).unwrap();
        assert_eq!(value.modules[0].status, "disabled");
        assert!(parse_health(br#"{"service":"other-service","modules":[]}"#).is_err());
        assert!(parse_health(br#"{"service":"nootify"}"#).is_err());
        assert!(
            parse_health(br#"{"service":"nootify","modules":[{"name":"lark"}]}"#)
                .is_err()
        );
        assert!(parse_health(&vec![b' '; HEALTH_LIMIT as usize + 1]).is_err());
    }

    #[test]
    fn launchd_actions_reuse_only_the_existing_job() {
        let plist = Path::new("/Users/test/Library/LaunchAgents/dev.idy.nootify.service.plist");
        assert_eq!(
            operation_args(JobAction::Start, true, 501, plist),
            vec![
                OsString::from("kickstart"),
                "gui/501/dev.idy.nootify.service".into()
            ]
        );
        assert_eq!(
            operation_args(JobAction::Restart, true, 501, plist),
            vec![
                OsString::from("kickstart"),
                "-k".into(),
                "gui/501/dev.idy.nootify.service".into()
            ]
        );
        for action in [JobAction::Start, JobAction::Restart] {
            assert_eq!(
                operation_args(action, false, 501, plist),
                vec![OsString::from("bootstrap"), "gui/501".into(), plist.into()]
            );
        }
    }
}
