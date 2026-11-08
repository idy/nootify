use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
use std::{
    ffi::{CString, OsString},
    io,
    net::{SocketAddr, TcpStream},
    os::unix::ffi::OsStrExt,
};

#[cfg(target_os = "macos")]
pub use LaunchAgent as BackgroundService;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::BackgroundService;

use reqwest::{blocking::Client, redirect::Policy};
use serde::Deserialize;

pub const SERVICE_URL: &str = "http://127.0.0.1:9417/";
#[cfg(target_os = "macos")]
const SERVICE_ADDR: ([u8; 4], u16) = ([127, 0, 0, 1], 9417);
#[cfg(target_os = "macos")]
pub const LABEL: &str = "dev.idy.nootify.service";
const HEALTH_LIMIT: u64 = 64 * 1024;
/// The installer itself waits up to about 21 s for the new job's health check.
#[cfg(target_os = "macos")]
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
const OUTPUT_LIMIT: usize = 64 * 1024;

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
    pub fn label(self) -> crate::language::Text {
        match self {
            Self::Start => crate::language::Text::StartService,
            Self::Restart => crate::language::Text::RestartService,
        }
    }
}

/// The Node.js runtime and service that ship inside Nootify.app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundledService {
    /// `Contents/MacOS/node`, the official Node.js binary staged as a Tauri sidecar.
    pub node: PathBuf,
    /// `Contents/Resources/service/dist/src/cli.js`.
    pub cli: PathBuf,
}

impl BundledService {
    /// `Ok(None)` outside an app bundle (development builds); an error if the bundle lacks its service.
    pub fn current() -> Result<Option<Self>, String> {
        let exe = std::env::current_exe()
            .and_then(fs::canonicalize)
            .map_err(|error| format!("Cannot locate the Nootify executable: {error}"))?;
        if cfg!(all(target_os = "windows", dev)) {
            return Ok(None);
        }
        let Some(bundled) = Self::locate(&exe) else {
            return Ok(None);
        };
        let tailscale = bundled.node.with_file_name(if cfg!(target_os = "windows") {
            "nootify-tsnet.exe"
        } else {
            "nootify-tsnet"
        });
        let core = bundled.node.with_file_name(if cfg!(target_os = "windows") {
            "nootify-core.exe"
        } else {
            "nootify-core"
        });
        for path in [&bundled.node, &bundled.cli, &tailscale, &core] {
            if !path.is_file() {
                return Err(format!("This app bundle has no {}", path.display()));
            }
        }
        Ok(Some(bundled))
    }

    #[cfg(target_os = "windows")]
    fn locate(exe: &Path) -> Option<Self> {
        let directory = exe.parent()?;
        Some(Self {
            node: directory.join("node.exe"),
            cli: directory.join("service/dist/src/cli.js"),
        })
    }

    #[cfg(target_os = "macos")]
    fn locate(exe: &Path) -> Option<Self> {
        let macos = exe.parent().filter(|dir| dir.ends_with("Contents/MacOS"))?;
        let contents = macos.parent()?;
        contents
            .parent()
            .filter(|app| app.extension().is_some_and(|extension| extension == "app"))?;
        Some(Self {
            node: macos.join("node"),
            cli: contents.join("Resources/service/dist/src/cli.js"),
        })
    }

    /// Runs `node --version`: proves the bundled runtime starts under this bundle's signature.
    pub fn node_version(&self) -> Result<String, String> {
        let mut command = Command::new(&self.node);
        command.arg("--version").env_clear();
        let output = run_with_timeout(command, Duration::from_secs(10))?;
        let version = output.stdout.trim();
        if !output.status.success() || !version.starts_with('v') {
            return Err(format!(
                "Bundled Node.js failed ({}): {}",
                output.status,
                menu_text(output.stderr.trim())
            ));
        }
        Ok(version.to_string())
    }
}

#[cfg(target_os = "macos")]
pub struct LaunchAgent {
    uid: u32,
    home: PathBuf,
    plist: PathBuf,
}

#[cfg(target_os = "macos")]
impl LaunchAgent {
    pub fn new(home: PathBuf) -> Self {
        Self {
            // SAFETY: geteuid has no arguments or memory preconditions.
            uid: unsafe { libc::geteuid() },
            plist: home
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
            home,
        }
    }

    pub fn installed(&self) -> bool {
        self.plist_present()
    }

    /// Anything at the plist path counts, even a dangling link or an unreadable entry: it is never rewritten.
    pub fn plist_present(&self) -> bool {
        !matches!(fs::symlink_metadata(&self.plist), Err(error) if error.kind() == io::ErrorKind::NotFound)
    }

    pub fn request(&self, action: JobAction) -> Result<(), String> {
        // Never install/rewrite a plist, run Node, or create another receiver.
        let loaded = self.loaded()?;
        if !loaded && port_in_use(SocketAddr::from(SERVICE_ADDR)) {
            return Err("127.0.0.1:9417 is occupied by another process; the existing service was left running".into());
        }
        if !loaded && !self.plist.is_file() {
            return Err(
                "LaunchAgent is not installed; install the background service first".into(),
            );
        }
        self.launchctl(operation_args(action, loaded, self.uid, &self.plist))
    }

    /// Installs the bundled service as the LaunchAgent, only while no plist exists. The bundled
    /// installer writes the plist with its own Node.js and server.js paths, then waits for health.
    pub fn install(&self, bundled: &BundledService) -> Result<(), String> {
        if self.plist_present() {
            return Err(format!(
                "{} already exists and is never rewritten",
                self.plist.display()
            ));
        }
        // A job that cannot bind the port crash-loops under KeepAlive, and as soon as the port
        // frees up it starts with the Feishu configuration: a second, competing event receiver.
        if port_in_use(SocketAddr::from(SERVICE_ADDR)) {
            return Err(
                "127.0.0.1:9417 is already in use by another process; stop it before installing"
                    .into(),
            );
        }
        // The plist pins this bundle's paths, which must outlive a disk image or App Translocation.
        if read_only_volume(&bundled.node) {
            return Err(
                "Nootify.app is on a read-only volume; move it to /Applications and reopen it"
                    .into(),
            );
        }
        let mcp_config = self.home.join(".claude.json");
        let mut command = Command::new(&bundled.node);
        command
            .args(install_args(
                &bundled.cli,
                mcp_config.is_file().then_some(mcp_config.as_path()),
            ))
            .current_dir(&self.home)
            // Nothing from the launching environment (NODE_OPTIONS, LARK_*) reaches the installer.
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        for name in ["USER", "LOGNAME", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let output = run_with_timeout(command, INSTALL_TIMEOUT)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(installer_error(&output))
        }
    }

    /// After an update replaced this app bundle, restarts the job if its plist runs this bundle's
    /// Node.js, so the service also runs the new code. Returns whether a restart was requested.
    pub fn restart_if_runs(&self, node: &Path) -> Result<bool, String> {
        if !self.plist.is_file() {
            return Ok(false);
        }
        let runs_node =
            plist_program(&self.plist)?.is_some_and(|program| same_file(&program, node));
        if !runs_node || !self.loaded()? {
            return Ok(false);
        }
        self.launchctl(operation_args(
            JobAction::Restart,
            true,
            self.uid,
            &self.plist,
        ))?;
        Ok(true)
    }

    fn loaded(&self) -> Result<bool, String> {
        Ok(Command::new("/bin/launchctl")
            .args(["print", &format!("gui/{}/{LABEL}", self.uid)])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Cannot inspect launchd: {error}"))?
            .success())
    }

    fn launchctl(&self, args: Vec<OsString>) -> Result<(), String> {
        let output = Command::new("/bin/launchctl")
            .args(args)
            .stdin(Stdio::null())
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn install_args(cli: &Path, mcp_config: Option<&Path>) -> Vec<OsString> {
    let mut args = vec![cli.into(), "launchd-install".into()];
    if let Some(config) = mcp_config {
        args.push("--mcp-config".into());
        args.push(config.into());
    }
    args
}

/// cli.js reports failures as one `{"error": "..."}` line on stderr.
fn installer_error(output: &CommandOutput) -> String {
    #[derive(Deserialize)]
    struct Failure {
        error: String,
    }
    output
        .stderr
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Failure>(line).ok())
        .map(|failure| failure.error)
        .unwrap_or_else(|| match output.stderr.trim() {
            "" => format!("installer exited with {}", output.status),
            text => text.to_string(),
        })
}

/// The executable a LaunchAgent plist runs (`ProgramArguments[0]`), if it names one.
#[cfg(target_os = "macos")]
fn plist_program(plist: &Path) -> Result<Option<PathBuf>, String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", "ProgramArguments.0", "raw", "-o", "-"])
        .arg(plist)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Cannot read the LaunchAgent plist: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = output.stdout.strip_suffix(b"\n").unwrap_or(&output.stdout);
    Ok((!value.is_empty()).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(value))))
}

#[cfg(target_os = "macos")]
fn port_in_use(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok()
}

#[cfg(target_os = "macos")]
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[cfg(target_os = "macos")]
fn read_only_volume(path: &Path) -> bool {
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: statfs only writes the zero-initialized struct it is given, and the path is NUL-terminated.
    unsafe {
        let mut stat: libc::statfs = std::mem::zeroed();
        libc::statfs(path.as_ptr(), &mut stat) == 0 && stat.f_flags & libc::MNT_RDONLY as u32 != 0
    }
}

#[derive(Debug)]
pub struct CommandOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a child to completion on the calling thread, killing it after `timeout`.
pub fn run_with_timeout(mut command: Command, timeout: Duration) -> Result<CommandOutput, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: background controls never flash a console.
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start {:?}: {error}", command.get_program()))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {} s", timeout.as_secs()));
            }
            Err(error) => return Err(format!("Cannot wait for child process: {error}")),
        }
    };
    // A grandchild that kept the pipes open must not hold this thread.
    let collect = |output: mpsc::Receiver<String>| {
        output
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_default()
    };
    Ok(CommandOutput {
        status,
        stdout: collect(stdout),
        stderr: collect(stderr),
    })
}

/// Reads a pipe to its end, so the child never blocks on a full pipe, keeping the first 64 KiB.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut pipe) = pipe {
            let mut buffer = [0; 8192];
            while let Ok(read @ 1..) = pipe.read(&mut buffer) {
                let room = OUTPUT_LIMIT.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        }
        let _ = sender.send(String::from_utf8_lossy(&kept).into_owned());
    });
    receiver
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn health_requires_our_service_and_module_contract() {
        let value = parse_health(
            br#"{"ok":true,"service":"nootify","modules":[{"name":"lark","status":"disabled"}]}"#,
        )
        .unwrap();
        assert_eq!(value.modules[0].status, "disabled");
        assert!(parse_health(br#"{"service":"other-service","modules":[]}"#).is_err());
        assert!(parse_health(br#"{"service":"nootify"}"#).is_err());
        assert!(parse_health(br#"{"service":"nootify","modules":[{"name":"lark"}]}"#).is_err());
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

    #[test]
    fn bundled_runtime_is_found_only_inside_an_app_bundle() {
        assert_eq!(
            BundledService::locate(Path::new(
                "/Applications/Nootify.app/Contents/MacOS/nootify"
            )),
            Some(BundledService {
                node: "/Applications/Nootify.app/Contents/MacOS/node".into(),
                cli: "/Applications/Nootify.app/Contents/Resources/service/dist/src/cli.js".into(),
            })
        );
        for exe in [
            "/repo/src-tauri/target/debug/nootify",
            "/repo/target/release/bundle/Contents/MacOS/nootify",
            "/Applications/Nootify/Contents/MacOS/nootify",
            "/nootify",
        ] {
            assert_eq!(BundledService::locate(Path::new(exe)), None, "{exe}");
        }
    }

    #[test]
    fn installer_gets_the_mcp_config_only_when_given() {
        let cli = Path::new("/A/Nootify.app/Contents/Resources/service/dist/src/cli.js");
        assert_eq!(
            install_args(cli, None),
            vec![OsString::from(cli), "launchd-install".into()]
        );
        assert_eq!(
            install_args(cli, Some(Path::new("/Users/test/.claude.json"))),
            vec![
                OsString::from(cli),
                "launchd-install".into(),
                "--mcp-config".into(),
                "/Users/test/.claude.json".into()
            ]
        );
    }

    #[test]
    fn existing_plist_is_never_passed_to_the_installer() {
        let home = std::env::temp_dir().join(format!("nootify-test-{}", std::process::id()));
        let agents = home.join("Library/LaunchAgents");
        fs::create_dir_all(&agents).unwrap();
        let agent = LaunchAgent::new(home.clone());
        assert!(!agent.plist_present());
        std::os::unix::fs::symlink("/nonexistent", agents.join(format!("{LABEL}.plist"))).unwrap();
        assert!(agent.plist_present(), "a dangling link still counts");
        // The refusal happens before anything is executed.
        let error = agent
            .install(&BundledService {
                node: "/nonexistent/node".into(),
                cli: "/nonexistent/cli.js".into(),
            })
            .unwrap_err();
        assert!(error.contains("never rewritten"), "{error}");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn install_requires_a_free_service_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(port_in_use(listener.local_addr().unwrap()));
        // Not the dropped listener's port: on macOS a child spawned by a parallel test can
        // inherit the socket before close-on-exec is set, keeping it open. Port 0 never accepts.
        assert!(!port_in_use(SocketAddr::from(([127, 0, 0, 1], 0))));
        assert_eq!(
            SocketAddr::from(SERVICE_ADDR).to_string(),
            SERVICE_URL
                .trim_start_matches("http://")
                .trim_end_matches('/')
        );
    }

    #[test]
    fn installer_errors_come_from_its_json_report() {
        let failed = |stderr: &str| CommandOutput {
            status: Command::new("/usr/bin/false").status().unwrap(),
            stdout: String::new(),
            stderr: stderr.into(),
        };
        assert_eq!(
            installer_error(&failed(
                "warning\n{\"error\":\"Refusing to replace an unrelated LaunchAgent\"}\n"
            )),
            "Refusing to replace an unrelated LaunchAgent"
        );
        assert_eq!(installer_error(&failed("plain failure\n")), "plain failure");
        assert!(installer_error(&failed("")).starts_with("installer exited with"));
    }

    #[test]
    fn child_processes_are_bounded_by_the_timeout() {
        let mut echo = Command::new("/bin/sh");
        echo.args(["-c", "printf out; printf err >&2"]);
        let output = run_with_timeout(echo, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert_eq!(
            (output.stdout.as_str(), output.stderr.as_str()),
            ("out", "err")
        );

        let mut sleep = Command::new("/bin/sleep");
        sleep.arg("30");
        let started = Instant::now();
        assert!(run_with_timeout(sleep, Duration::from_millis(300))
            .unwrap_err()
            .contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    // Only the decision is tested: restart_if_runs itself would kickstart a real loaded job.
    #[test]
    fn job_restart_follows_only_this_bundles_node() {
        let dir = std::env::temp_dir().join(format!("nootify-same-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let node = dir.join("node");
        fs::write(&node, b"").unwrap();
        std::os::unix::fs::symlink(&node, dir.join("link")).unwrap();
        assert!(same_file(&node, &dir.join("link")));
        assert!(!same_file(&node, Path::new("/opt/homebrew/bin/node")));

        let plist = dir.join("job.plist");
        fs::write(&plist, format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>{LABEL}</string>
<key>ProgramArguments</key><array><string>{}</string><string>/x/server.js</string></array></dict></plist>"#,
            dir.join("link").display()
        ))
        .unwrap();
        let program = plist_program(&plist).unwrap().unwrap();
        assert_eq!(program, dir.join("link"));
        assert!(same_file(&program, &node));
        fs::write(&plist, "<plist version=\"1.0\"><dict></dict></plist>").unwrap();
        assert_eq!(plist_program(&plist).unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
