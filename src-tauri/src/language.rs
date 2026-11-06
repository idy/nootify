//! App-owned language preference, deliberately independent of daemon and browser settings.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSLocale, NSString};
use objc2_web_kit::{WKUserContentController, WKUserScript, WKUserScriptInjectionTime};
use serde::{Deserialize, Serialize};
use tauri::{Url, WebviewWindow};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub enum Preference {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum Locale {
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}

impl Locale {
    pub fn resolve(language: &str) -> Self {
        if language.to_ascii_lowercase().starts_with("zh") {
            Self::Chinese
        } else {
            Self::English
        }
    }

    pub fn format(self, key: Text, values: &[(&str, &str)]) -> String {
        interpolate(self.text(key), values)
    }
}

pub fn system_locale() -> Locale {
    NSLocale::preferredLanguages()
        .firstObject()
        .map_or(Locale::English, |language| {
            Locale::resolve(&language.to_string())
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LanguageView {
    pub preference: Preference,
    pub locale: Locale,
}

const SCRIPT_MARKER: &str = "// nootify-language\n";

impl LanguageView {
    pub fn new(preference: Preference, system: Locale) -> Self {
        Self {
            preference,
            locale: match preference {
                Preference::System => system,
                Preference::Chinese => Locale::Chinese,
                Preference::English => Locale::English,
            },
        }
    }

    /// Runs at document start, before the service page's JavaScript reads its language.
    pub fn initialization_script(self) -> String {
        format!(
            "{SCRIPT_MARKER}window.__NOOTIFY_LANGUAGE__ = {};\n{}",
            serde_json::to_string(&self).expect("language state serializes"),
            include_str!("../../desktop/offline.js")
        )
    }

    /// Replays the same object after load and after a preference change, including the fallback.
    pub fn script(self) -> String {
        format!(
            "window.__NOOTIFY_LANGUAGE__ = {}; window.dispatchEvent(new CustomEvent('nootify-language', {{ detail: window.__NOOTIFY_LANGUAGE__ }}));",
            serde_json::to_string(&self).expect("language state serializes")
        )
    }
}

/// Replace only our document-start script. Preserving the other WKUserScripts keeps Tauri's
/// security setup and the titlebar bridge intact; app preferences never touch web storage.
pub fn refresh_initialization(window: &WebviewWindow, view: LanguageView) -> tauri::Result<()> {
    let source = view.initialization_script();
    window.with_webview(move |platform| {
        let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
        // SAFETY: Tauri supplies Wry's live WKUserContentController on its owning main thread.
        // Snapshot retained script objects before removal: WebKit mutates the returned NSArray.
        // Keeping that NSArray alone would silently remove Tauri's security/titlebar scripts.
        unsafe {
            let controller = &*platform.controller().cast::<WKUserContentController>();
            let scripts = controller.userScripts().iter().collect::<Vec<_>>();
            let replacement = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(mtm),
                &NSString::from_str(&source),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            );
            controller.removeAllUserScripts();
            let mut replaced = false;
            for script in &scripts {
                if script.source().to_string().starts_with(SCRIPT_MARKER) {
                    controller.addUserScript(&replacement);
                    replaced = true;
                } else {
                    controller.addUserScript(script);
                }
            }
            if !replaced {
                controller.addUserScript(&replacement);
            }
        }
    })
}

/// Exact fixed requests only: no credentials, port, query, fragment, escaping, or extra path.
/// The caller separately checks that the current document is a trusted Nootify page.
pub fn page_request(url: &Url) -> Option<Preference> {
    match url.as_str() {
        "nootify://language/system" => Some(Preference::System),
        "nootify://language/zh-CN" => Some(Preference::Chinese),
        "nootify://language/en" => Some(Preference::English),
        _ => None,
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    preference: Preference,
}

pub struct LanguageStore {
    path: Option<PathBuf>,
    pub view: LanguageView,
}

impl LanguageStore {
    /// A missing, unreadable, oversized, or corrupt preference always falls back to the system.
    /// Smoke runs pass no path so they cannot change the real app's saved preference.
    pub fn load(path: Option<PathBuf>) -> Self {
        let preference = path.as_ref().map_or(Preference::System, |path| {
            read_preference(path).unwrap_or_else(|error| {
                eprintln!("Cannot load app language preference: {error}");
                Preference::System
            })
        });
        Self {
            path,
            view: LanguageView::new(preference, system_locale()),
        }
    }

    pub fn refresh_system(&mut self) -> Option<LanguageView> {
        if self.view.preference != Preference::System {
            return None;
        }
        let next = LanguageView::new(Preference::System, system_locale());
        if next == self.view {
            return None;
        }
        self.view = next;
        Some(next)
    }

    pub fn set(&mut self, preference: Preference) -> io::Result<LanguageView> {
        if let Some(path) = &self.path {
            write_preference(path, preference)?;
        }
        // Commit the in-memory preference only after persistence succeeds.
        self.view = LanguageView::new(preference, system_locale());
        Ok(self.view)
    }
}

fn read_preference(path: &Path) -> io::Result<Preference> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Preference::System),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes)?;
    if bytes.len() > 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "language preference exceeds 1 KiB",
        ));
    }
    serde_json::from_slice::<Settings>(&bytes)
        .map(|settings| settings.preference)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_preference(path: &Path, preference: Preference) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("app config directory is missing"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(&Settings { preference })?)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Interpolate once, so a diagnostic or version containing a placeholder is always literal data.
fn interpolate(template: &str, values: &[(&str, &str)]) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        result.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find('}') else { break };
        let name = &rest[1..end];
        if let Some((_, value)) = values.iter().find(|(key, _)| *key == name) {
            result.push_str(value);
        } else {
            result.push_str(&rest[..=end]);
        }
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    result
}

macro_rules! catalog {
    ($($key:ident => ($en:literal, $zh:literal)),+ $(,)?) => {
        #[derive(Clone, Copy, Debug)]
        pub enum Text { $($key),+ }
        impl Locale {
            pub fn text(self, key: Text) -> &'static str {
                match (self, key) {
                    $((Self::English, Text::$key) => $en,
                      (Self::Chinese, Text::$key) => $zh),+
                }
            }
        }
    };
}

catalog! {
    Open => ("Open Nootify", "打开 Nootify"),
    CheckingHealth => ("Nootify · Checking…", "Nootify · 检查中…"),
    Refresh => ("Refresh Status", "刷新状态"),
    Modules => ("Module Status", "模块状态"),
    CheckingModules => ("Checking…", "正在检查…"),
    ServiceKeepsRunning => ("Service keeps running after quit", "退出后服务仍会运行"),
    RetryStart => ("Retry Start", "重试启动"),
    Restart => ("Restart", "重新启动"),
    InstallService => ("Install Background Service", "安装后台服务"),
    BackgroundService => ("Background Service", "后台服务"),
    Settings => ("Settings…", "设置…"),
    Quit => ("Quit Nootify", "退出 Nootify"),
    Running => ("Nootify · Running", "Nootify · 运行中"),
    Offline => ("Nootify · Not Connected", "Nootify · 未连接"),
    ModuleDetail => ("Modules: {modules}", "模块：{modules}"),
    Reason => ("Reason: {error}", "原因：{error}"),
    ModuleStatus => ("{name}: {status}", "{name}：{status}"),
    Sessions => ("Sessions", "会话"),
    Lark => ("Feishu", "飞书"),
    Pulls => ("PR", "PR"),
    Agents => ("Agents", "Agents"),
    Ready => ("Ready", "就绪"),
    Disabled => ("Disabled", "未启用"),
    Connecting => ("Connecting", "连接中"),
    Reconnecting => ("Reconnecting", "重新连接中"),
    Failed => ("Failed", "失败"),
    Stopped => ("Stopped", "已停止"),
    Refreshing => ("Refreshing", "刷新中"),
    SignedOut => ("Signed Out", "未登录"),
    Stale => ("Out of Date", "数据已过期"),
    Error => ("Error", "出错"),
    Idle => ("Idle", "空闲"),
    StartService => ("Start service", "启动服务"),
    RestartService => ("Restart service", "重启服务"),
    StartingService => ("Starting background service…", "正在启动后台服务…"),
    RestartingService => ("Restarting service…", "正在重启服务…"),
    InstallingService => ("Installing background service…", "正在安装后台服务…"),
    StartRequested => ("Background service start requested", "已请求启动后台服务"),
    RestartRequested => ("Service restart requested", "已请求重启服务"),
    AutoInstalled => ("Background service installed and running", "后台服务已自动安装并运行"),
    Installed => ("Background service installed and running", "后台服务已安装并运行"),
    ActionFailed => ("{action} failed: {error}", "{action}失败：{error}"),
    CurrentVersion => ("Current version {version}", "当前版本 {version}"),
    CheckUpdate => ("Check for Updates…", "检查更新…"),
    InstallUpdate => ("Install Update", "安装更新"),
    InstallVersion => ("Install Update {version}", "安装更新 {version}"),
    UpdateDetails => ("Update Details…", "更新详情…"),
    SoftwareUpdates => ("Software Updates", "软件更新"),
    UpdateVersion => ("Update {version}", "更新 {version}"),
    CheckingUpdate => ("Checking for updates…", "检查更新中…"),
    UpdateAvailable => ("Update available: {version}", "可更新至 {version}"),
    UpToDate => ("Up to date: {version}", "已是最新 {version}"),
    CheckFailed => ("Check failed. Try again.", "检查失败，请重试"),
    Downloading => ("Downloading…", "下载中…"),
    DownloadPercent => ("Downloading {percent}%", "下载中 {percent}%"),
    Installing => ("Installing…", "安装中…"),
    InstallFailed => ("Install failed. Try again.", "安装失败，请重试"),
    Restarting => ("Restarting…", "重启中…"),
    About => ("About Nootify", "关于 Nootify"),
    Services => ("Services", "服务"),
    Hide => ("Hide Nootify", "隐藏 Nootify"),
    HideOthers => ("Hide Others", "隐藏其他"),
    File => ("File", "文件"),
    CloseWindow => ("Close Window", "关闭窗口"),
    Edit => ("Edit", "编辑"),
    Undo => ("Undo", "撤销"),
    Redo => ("Redo", "重做"),
    Cut => ("Cut", "剪切"),
    Copy => ("Copy", "复制"),
    Paste => ("Paste", "粘贴"),
    SelectAll => ("Select All", "全选"),
    View => ("View", "显示"),
    Fullscreen => ("Enter Full Screen", "进入全屏幕"),
    Window => ("Window", "窗口"),
    Minimize => ("Minimize", "最小化"),
    Zoom => ("Zoom", "缩放"),
    Help => ("Help", "帮助"),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_language_resolves_all_chinese_variants_and_defaults_to_english() {
        for language in ["zh", "zh-CN", "zh-Hant-TW", "zh_HK", "ZH-sg"] {
            assert_eq!(Locale::resolve(language), Locale::Chinese, "{language}");
        }
        for language in ["en", "en-GB", "fr-FR", "ja-JP", "", "unknown"] {
            assert_eq!(Locale::resolve(language), Locale::English, "{language}");
        }
        for system in [Locale::English, Locale::Chinese] {
            assert_eq!(LanguageView::new(Preference::System, system).locale, system);
            assert_eq!(
                LanguageView::new(Preference::Chinese, system).locale,
                Locale::Chinese
            );
            assert_eq!(
                LanguageView::new(Preference::English, system).locale,
                Locale::English
            );
        }
    }

    #[test]
    fn requests_only_accept_the_three_exact_language_urls() {
        for (path, preference) in [
            ("system", Preference::System),
            ("zh-CN", Preference::Chinese),
            ("en", Preference::English),
        ] {
            assert_eq!(
                page_request(&Url::parse(&format!("nootify://language/{path}")).unwrap()),
                Some(preference)
            );
        }
        for url in [
            "https://language/en",
            "nootify://other/en",
            "nootify://language/",
            "nootify://language/zh",
            "nootify://language/zh-cn",
            "nootify://language/EN",
            "nootify://language/en/",
            "nootify://language/en?",
            "nootify://language/en?target=other",
            "nootify://language/en#",
            "nootify://language/en#other",
            "nootify://user@language/en",
            "nootify://user:secret@language/en",
            "nootify://language:9417/en",
            "nootify://language/%65n",
            "nootify://language/system/other",
            "nootify://language//en",
        ] {
            assert_eq!(page_request(&Url::parse(url).unwrap()), None, "{url}");
        }
    }

    #[test]
    fn preference_persistence_round_trips_without_rewriting_other_config() {
        let dir = std::env::temp_dir().join(format!("nootify-language-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app/language.json");
        assert_eq!(read_preference(&path).unwrap(), Preference::System);
        fs::write(dir.join("daemon.json"), "untouched").unwrap();
        for preference in [Preference::Chinese, Preference::English, Preference::System] {
            write_preference(&path, preference).unwrap();
            assert_eq!(read_preference(&path).unwrap(), preference);
        }
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::read_to_string(dir.join("daemon.json")).unwrap(),
            "untouched"
        );
        for invalid in [
            "{}",
            r#"{"preference":"fr"}"#,
            "[]",
            "not JSON",
            r#"{"preference":"en","token":"no"}"#,
        ] {
            fs::write(&path, invalid).unwrap();
            assert!(read_preference(&path).is_err(), "{invalid}");
            assert_eq!(
                LanguageStore::load(Some(path.clone())).view.preference,
                Preference::System
            );
        }
        fs::write(&path, vec![b' '; 1025]).unwrap();
        assert!(read_preference(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn system_refresh_only_publishes_changes_for_the_system_preference() {
        let system = system_locale();
        let opposite = if system == Locale::English {
            Locale::Chinese
        } else {
            Locale::English
        };
        let mut store = LanguageStore {
            path: None,
            view: LanguageView::new(Preference::System, opposite),
        };
        assert_eq!(
            store.refresh_system(),
            Some(LanguageView::new(Preference::System, system))
        );
        assert_eq!(store.refresh_system(), None);
        store.view = LanguageView::new(Preference::Chinese, system);
        assert_eq!(store.refresh_system(), None);
        assert_eq!(store.view.locale, Locale::Chinese);
    }

    #[test]
    fn persistence_failure_does_not_change_authoritative_state() {
        let path =
            std::env::temp_dir().join(format!("nootify-language-blocked-{}", std::process::id()));
        fs::write(&path, "not a directory").unwrap();
        let view = LanguageView::new(Preference::English, Locale::Chinese);
        let mut store = LanguageStore {
            path: Some(path.join("language.json")),
            view,
        };
        assert!(store.set(Preference::Chinese).is_err());
        assert_eq!(store.view, view);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn initialization_and_replay_supply_the_same_contract() {
        let view = LanguageView::new(Preference::System, Locale::Chinese);
        let json = r#"{"preference":"system","locale":"zh-CN"}"#;
        assert!(view.initialization_script().starts_with(&format!(
            "{SCRIPT_MARKER}window.__NOOTIFY_LANGUAGE__ = {json};"
        )));
        assert!(view
            .script()
            .contains(&format!("window.__NOOTIFY_LANGUAGE__ = {json};")));
        assert!(view.script().contains(
            "new CustomEvent('nootify-language', { detail: window.__NOOTIFY_LANGUAGE__ })"
        ));
    }

    #[test]
    fn interpolation_preserves_unicode_and_never_reinterprets_inserted_values() {
        assert_eq!(
            Locale::Chinese.format(Text::ModuleStatus, &[("name", "会话"), ("status", "就绪")]),
            "会话：就绪"
        );
        assert_eq!(
            Locale::English.format(
                Text::ActionFailed,
                &[
                    ("action", "Start service"),
                    ("error", "{action}: \"failed\"\n路径")
                ]
            ),
            "Start service failed: {action}: \"failed\"\n路径"
        );
        assert_eq!(
            interpolate("{one} {one} {missing} {", &[("one", "中")]),
            "中 中 {missing} {"
        );
    }
}
