//! 本机 Agent CLI 的探测与官方升级。
//!
//! 适配器只声明发布信息（二进制名、npm 包、非 npm 安装时的自更新参数）。
//! 设置页和新建会话消费 `AgentInstallation`，不比较 Agent 种类。
//!
//! 有 npm 包时，版本对照走 `npm view <pkg> version`。升级按安装方式分流：
//! 全局 npm 安装执行 `npm install -g <pkg>@latest`；否则执行该二进制声明的
//! 官方自更新参数。没有 npm 包时不查询 registry。声明了自更新就先提供一次更新；
//! 官方命令确认这个版本已是最新后，同版本的后续探测不再显示更新。
//! 工作台不代为安装缺失的 CLI。

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::models::{AgentInstallation, AgentKind, UpdateVia};

mod command;
mod version;

use command::{
    clip, failure_text, find_bin, npm_lists_global, run_captured, Captured,
};
use version::version_from_output;
pub use version::{extract_version, is_newer, parse_published_version};

#[cfg(any(windows, test))]
pub(crate) use command::cmd_invocation_line;
#[cfg(test)]
use command::windows_cmd_line;


/// 一种本地 CLI 的发布渠道。字段都是静态的，方便适配器用常量声明。
#[derive(Clone, Copy)]
pub struct CliRelease {
    /// 探测顺序。第一项是当前官方入口，后面的是兼容名。
    pub bins: &'static [&'static str],
    /// 空字符串表示不是 npm 包，不查询 registry，也不走 `npm install`。
    pub npm_package: &'static str,
    /// 不是 npm 全局安装时，相对已发现二进制执行的官方升级参数。
    pub self_update: &'static [&'static str],
    /// 适配器自己的定位。Codex 复用会话启动时的查找，避免设置页和会话各找一套。
    pub locate: Option<fn() -> Option<PathBuf>>,
    /// 读版本的参数。空则用 `--version`。别名可用 `AliasRule::version_args` 覆盖。
    pub version_args: &'static [&'static str],
    pub aliases: &'static [AliasRule],
    /// 设置页上的别名或更新说明。空则不展示。
    pub note: &'static str,
}

/// 某个兼容入口怎么确认、怎么更新。
#[derive(Clone, Copy)]
pub struct AliasRule {
    pub name: &'static str,
    pub check: AliasCheck,
    /// 覆盖版本参数。`None` 用 `CliRelease::version_args`。
    pub version_args: Option<&'static [&'static str]>,
    /// 覆盖升级参数。`Some(&[])` 表示这个入口不能在应用内更新。
    pub update_args: Option<&'static [&'static str]>,
}

/// 兼容命令的确认方式。短名字可能被无关程序占用。
#[derive(Clone, Copy)]
pub enum AliasCheck {
    /// 找到文件即可。版本命令失败也算已安装。
    None,
    /// 版本输出（忽略大小写）必须包含其中一段。
    #[allow(dead_code)]
    Contains(&'static [&'static str]),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinHit {
    pub name: String,
    pub version_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChosenBin {
    pub name: String,
    pub version: Option<String>,
    pub also: Vec<String>,
    pub update_args: &'static [&'static str],
    pub can_update: bool,
}

/// Cursor 官方安装位置。PATH 上别的 `agent` 不能拿来更新。
pub fn locate_cursor_agent() -> Option<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")?;
    let path = PathBuf::from(root).join("cursor-agent").join("agent.cmd");
    path.is_file().then_some(path)
}

pub fn locate_release(release: &CliRelease) -> Option<PathBuf> {
    if let Some(locate) = release.locate {
        if let Some(path) = locate() {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    find_bin(release.bins)
}

struct FoundBin {
    name: String,
    path: PathBuf,
    version_text: Option<String>,
}

/// 按声明顺序找二进制，并读版本。别名确认在 `choose_bin` 里做。
async fn discover(release: &CliRelease) -> Vec<FoundBin> {
    let mut found = Vec::new();
    for (index, name) in release.bins.iter().enumerate() {
        let path = if index == 0 {
            if let Some(locate) = release.locate {
                locate().filter(|path| path.is_file())
            } else {
                None
            }
        } else {
            None
        };
        let Some(path) = path.or_else(|| find_bin(&[*name])) else {
            continue;
        };
        let version_text = match run_captured(
            &path,
            version_args(release, name),
            Duration::from_secs(15),
            false,
        )
        .await
        {
            Ok(captured) => Some(format!("{}\n{}", captured.stdout, captured.stderr)),
            Err(_) => None,
        };
        found.push(FoundBin {
            name: (*name).to_string(),
            path,
            version_text,
        });
    }
    found
}

pub fn choose_bin(release: &CliRelease, hits: &[BinHit]) -> Option<ChosenBin> {
    let mut chosen: Option<ChosenBin> = None;
    for name in release.bins {
        let Some(hit) = hits.iter().find(|hit| hit.name == *name) else {
            continue;
        };
        let rule = release.aliases.iter().find(|rule| rule.name == *name);
        if !hit_accepted(rule, hit) {
            continue;
        }
        if let Some(chosen) = chosen.as_mut() {
            chosen.also.push((*name).to_string());
            continue;
        }
        let (update_args, can_update) = update_of(release, rule);
        chosen = Some(ChosenBin {
            name: (*name).to_string(),
            version: hit
                .version_text
                .as_deref()
                .and_then(|text| version_from_output(text, "")),
            also: Vec::new(),
            update_args,
            can_update,
        });
    }
    chosen
}

fn update_of(release: &CliRelease, rule: Option<&AliasRule>) -> (&'static [&'static str], bool) {
    if let Some(args) = rule.and_then(|rule| rule.update_args) {
        return (args, !args.is_empty());
    }
    (release.self_update, !release.self_update.is_empty())
}

fn hit_accepted(rule: Option<&AliasRule>, hit: &BinHit) -> bool {
    let check = rule.map(|rule| rule.check).unwrap_or(AliasCheck::None);
    confirms(check, hit.version_text.as_deref())
}

pub fn confirms(check: AliasCheck, text: Option<&str>) -> bool {
    match check {
        AliasCheck::None => true,
        AliasCheck::Contains(needles) => {
            let Some(text) = text else {
                return false;
            };
            let lower = text.to_ascii_lowercase();
            needles
                .iter()
                .any(|needle| lower.contains(&needle.to_ascii_lowercase()))
        }
    }
}

fn version_args<'a>(release: &'a CliRelease, name: &str) -> &'a [&'a str] {
    if let Some(rule) = release.aliases.iter().find(|rule| rule.name == name) {
        if let Some(args) = rule.version_args {
            if !args.is_empty() {
                return args;
            }
        }
    }
    if release.version_args.is_empty() {
        &["--version"]
    } else {
        release.version_args
    }
}

fn absent_with_note(kind: AgentKind, display_name: &str, note: &str) -> AgentInstallation {
    let mut item = AgentInstallation::absent(kind, display_name);
    if !note.is_empty() {
        item.detail = Some(note.to_string());
    }
    item
}

fn detail_lines(
    note: &str,
    also: &[String],
    version: &Option<String>,
    npm_note: Option<String>,
) -> Option<String> {
    let mut lines = Vec::new();
    if !also.is_empty() {
        lines.push(format!("同时发现 {}", also.join("、")));
    }
    if !note.is_empty() {
        lines.push(note.to_string());
    }
    if version.is_none() {
        lines.push("已找到命令，但没有读到版本号。".to_string());
    } else if let Some(npm_note) = npm_note {
        lines.push(npm_note);
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join(" "))
    }
}

pub async fn inspect_release(
    kind: AgentKind,
    display_name: &str,
    release: &CliRelease,
) -> AgentInstallation {
    let found = discover(release).await;
    let hits: Vec<BinHit> = found
        .iter()
        .map(|item| BinHit {
            name: item.name.clone(),
            version_text: item.version_text.clone(),
        })
        .collect();
    let Some(chosen) = choose_bin(release, &hits) else {
        return absent_with_note(kind, display_name, release.note);
    };
    let Some(bin) = found.iter().find(|item| item.name == chosen.name) else {
        return absent_with_note(kind, display_name, release.note);
    };

    let tracks_npm = !release.npm_package.is_empty();
    let npm = if tracks_npm { find_bin(&["npm"]) } else { None };
    let listed_globally = if !tracks_npm {
        false
    } else if looks_like_npm_install(&bin.path) {
        true
    } else if let Some(npm) = &npm {
        npm_lists_global(npm, release.npm_package).await
    } else {
        false
    };

    let latest_version = if !tracks_npm {
        None
    } else {
        match &npm {
            Some(npm) => match run_captured(
                npm,
                &["view", release.npm_package, "version"],
                Duration::from_secs(25),
                true,
            )
            .await
            {
                Ok(captured) if captured.code == 0 => parse_published_version(&captured.stdout),
                _ => None,
            },
            None => None,
        }
    };

    let settled = if tracks_npm {
        None
    } else {
        super::settled::current_version(kind)
    };
    let update_available = if tracks_npm {
        match (&latest_version, &chosen.version) {
            (Some(latest), Some(current)) => is_newer(latest, current),
            _ => false,
        }
    } else {
        super::settled::offer_self_update(
            chosen.can_update,
            chosen.version.as_deref(),
            settled.as_deref(),
        )
    };
    let latest_version = if tracks_npm {
        latest_version
    } else {
        super::settled::settled_latest(chosen.version.as_deref(), settled.as_deref())
    };
    let update_via = if tracks_npm {
        Some(choose_update_via(
            &bin.path,
            listed_globally,
            chosen.can_update,
        ))
    } else if chosen.can_update {
        Some(UpdateVia::Cli)
    } else {
        None
    };
    let npm_note = if !tracks_npm || chosen.version.is_none() {
        None
    } else if latest_version.is_none() && npm.is_none() {
        Some("未找到 npm，暂时无法对照官方版本。".to_string())
    } else if latest_version.is_none() {
        Some("暂时无法查询官方最新版本。".to_string())
    } else {
        None
    };

    AgentInstallation {
        kind,
        display_name: display_name.to_string(),
        installed: true,
        version: chosen.version.clone(),
        latest_version,
        update_available,
        update_via,
        detail: detail_lines(release.note, &chosen.also, &chosen.version, npm_note),
        session_linked: false,
    }
}

pub async fn upgrade_release(
    kind: AgentKind,
    display_name: &str,
    release: &CliRelease,
) -> Result<AgentInstallation, String> {
    let current = inspect_release(kind, display_name, release).await;
    if !current.installed {
        return Err(format!("未安装 {display_name}"));
    }
    if !current.update_available {
        return Ok(current);
    }

    let found = discover(release).await;
    let hits: Vec<BinHit> = found
        .iter()
        .map(|item| BinHit {
            name: item.name.clone(),
            version_text: item.version_text.clone(),
        })
        .collect();
    let chosen =
        choose_bin(release, &hits).ok_or_else(|| format!("未找到 {display_name} 的命令"))?;
    let bin = found
        .iter()
        .find(|item| item.name == chosen.name)
        .map(|item| item.path.clone())
        .ok_or_else(|| format!("未找到 {display_name} 的命令"))?;
    let via = current.update_via.unwrap_or(UpdateVia::Npm);
    let (label, outcome) = match via {
        UpdateVia::Npm => {
            if release.npm_package.is_empty() {
                return Err(format!("{display_name} 没有 npm 包，不能按 npm 升级。"));
            }
            let npm =
                find_bin(&["npm"]).ok_or_else(|| "未找到 npm，无法按官方方式升级。".to_string())?;
            let spec = format!("{}@latest", release.npm_package);
            let args = ["install", "-g", spec.as_str(), "--no-fund", "--no-audit"];
            (
                command_label(&npm, &args),
                run_captured(&npm, &args, Duration::from_secs(180), true).await,
            )
        }
        UpdateVia::Cli => {
            if chosen.update_args.is_empty() {
                return Err(format!("{display_name} 没有官方更新入口"));
            }
            (
                command_label(&bin, chosen.update_args),
                run_captured(&bin, chosen.update_args, Duration::from_secs(600), false).await,
            )
        }
    };

    match outcome {
        Ok(captured) if captured.code == 0 => {
            settle_cli_update(kind, display_name, release, &current, &captured, &label).await
        }
        Ok(captured) => Err(clip(
            &format!(
                "{label} 失败（退出码 {}）：{}",
                captured.code,
                failure_text(&captured)
            ),
            400,
        )),
        Err(err) => Err(format!("{label}：{err}")),
    }
}

async fn settle_cli_update(
    kind: AgentKind,
    display_name: &str,
    release: &CliRelease,
    before: &AgentInstallation,
    captured: &Captured,
    label: &str,
) -> Result<AgentInstallation, String> {
    let mut refreshed = inspect_release(kind, display_name, release).await;
    let output = format!("{} {}", captured.stdout.trim(), captured.stderr.trim());
    let output = output.trim();
    if update_failed(output) {
        return Err(clip(&format!("{label} 失败。{output}"), 400));
    }
    let changed = refreshed.version.is_some() && refreshed.version != before.version;
    if changed || cli_reports_current(output) {
        if release.npm_package.is_empty() {
            if let Some(version) = refreshed.version.as_deref() {
                super::settled::remember_current(kind, version);
            }
        }
        refreshed.update_available = false;
        if refreshed.latest_version.is_none() {
            refreshed.latest_version = refreshed.version.clone();
        }
        return Ok(refreshed);
    }
    let detail = if output.is_empty() {
        format!("{label} 没有返回结果。")
    } else {
        format!("{label}：{output}")
    };
    Err(clip(&format!("更新没有完成。{detail}"), 400))
}

fn update_failed(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("update failed")
        || lower.contains("couldn't check for updates")
        || lower.contains("could not check for updates")
}

fn cli_reports_current(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    if lower.contains("not up to date")
        || lower.contains("update available")
        || lower.contains("update failed")
    {
        return false;
    }
    lower.contains("already up to date")
        || lower.contains("already current")
        || output.contains("已是最新")
}

fn command_label(bin: &Path, args: &[&str]) -> String {
    let text = bin.to_string_lossy();
    let file = text.rsplit(['/', '\\']).next().unwrap_or("cli");
    let name = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => stem,
        _ => file,
    };
    let name = if name.is_empty() { "cli" } else { name };
    if args.is_empty() {
        name.to_string()
    } else {
        format!("{name} {}", args.join(" "))
    }
}

pub fn choose_update_via(path: &Path, npm_global: bool, has_self_update: bool) -> UpdateVia {
    if looks_like_npm_install(path) || npm_global {
        UpdateVia::Npm
    } else if has_self_update {
        UpdateVia::Cli
    } else {
        UpdateVia::Npm
    }
}

pub fn looks_like_npm_install(path: &Path) -> bool {
    let text = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    text.contains("/node_modules/") || text.contains("/npm/") || text.ends_with("/npm")
}

#[cfg(test)]
mod tests {
    use super::version::version_from_output;
    use super::*;

    #[test]
    fn reads_cli_version_lines() {
        assert_eq!(extract_version("codex-cli 0.162.1"), Some("0.162.1".into()));
        assert_eq!(
            extract_version("2.1.292 (Claude Code)"),
            Some("2.1.292".into())
        );
        assert_eq!(extract_version("no version here"), None);
    }

    #[test]
    fn compares_dotted_versions() {
        assert!(is_newer("0.162.0", "0.160.0"));
        assert!(is_newer("2.1.292", "2.1.200"));
        assert!(!is_newer("0.160.0", "0.160.0"));
        assert!(!is_newer("0.159.9", "0.160.0"));
    }

    #[test]
    fn published_version_ignores_npm_warnings() {
        let stdout = "npm warn deprecated example@1.2.3\n0.162.0\n";
        assert_eq!(parse_published_version(stdout), Some("0.162.0".into()));
    }

    #[test]
    fn npm_install_uses_npm_channel() {
        let vendor = Path::new(
            r"C:\Users\a\AppData\Roaming\npm\node_modules\@openai\codex\vendor\codex.exe",
        );
        assert!(looks_like_npm_install(vendor));
        assert_eq!(choose_update_via(vendor, false, true), UpdateVia::Npm);

        let shim = Path::new(r"C:\Users\a\AppData\Roaming\npm\claude.cmd");
        assert!(looks_like_npm_install(shim));
        assert_eq!(choose_update_via(shim, false, true), UpdateVia::Npm);
    }

    #[test]
    fn standalone_binary_uses_cli_update() {
        let path = Path::new(r"C:\Users\a\.local\bin\claude.exe");
        assert!(!looks_like_npm_install(path));
        assert_eq!(choose_update_via(path, false, true), UpdateVia::Cli);
        assert_eq!(choose_update_via(path, true, true), UpdateVia::Npm);
    }

    #[tokio::test]
    #[ignore]
    async fn live_inspect_prints_local_clis() {
        for (kind, name, bins, package) in [
            (
                AgentKind::CodexCli,
                "Codex CLI",
                &["codex"][..],
                "@openai/codex",
            ),
            (
                AgentKind::ClaudeCode,
                "Claude Code",
                &["claude"][..],
                "@anthropic-ai/claude-code",
            ),
        ] {
            let release = CliRelease {
                bins,
                npm_package: package,
                self_update: &["update"],
                locate: None,
                version_args: &[],
                aliases: &[],
                note: "",
            };
            let found = inspect_release(kind, name, &release).await;
            eprintln!(
                "{name}: installed={} version={:?} latest={:?} update={} via={:?}",
                found.installed,
                found.version,
                found.latest_version,
                found.update_available,
                found.update_via
            );
        }
    }

    fn sample_release() -> CliRelease {
        CliRelease {
            bins: &["agy", "antigravity", "gemini"],
            npm_package: "",
            self_update: &["update"],
            locate: None,
            version_args: &[],
            aliases: &[AliasRule {
                name: "gemini",
                check: AliasCheck::None,
                version_args: None,
                update_args: Some(&[]),
            }],
            note: "gemini 是停更前的入口",
        }
    }

    fn hit(name: &str, version: Option<&str>) -> BinHit {
        BinHit {
            name: name.to_string(),
            version_text: version.map(str::to_string),
        }
    }

    #[test]
    fn prefers_primary_binary_and_records_aliases() {
        let release = sample_release();
        let chosen = choose_bin(
            &release,
            &[hit("gemini", Some("0.1.0")), hit("agy", Some("agy 1.2.0"))],
        )
        .expect("agy");
        assert_eq!(chosen.name, "agy");
        assert_eq!(chosen.version.as_deref(), Some("1.2.0"));
        assert_eq!(chosen.also, vec!["gemini".to_string()]);
        assert!(chosen.can_update);
        assert_eq!(chosen.update_args, &["update"]);
    }

    #[test]
    fn retired_gemini_binary_cannot_update_in_app() {
        let chosen =
            choose_bin(&sample_release(), &[hit("gemini", Some("gemini 0.30.0"))]).expect("gemini");
        assert_eq!(chosen.name, "gemini");
        assert!(!chosen.can_update);
        assert!(chosen.update_args.is_empty());
    }

    #[test]
    fn substring_confirm_rejects_unrelated_output() {
        assert!(confirms(
            AliasCheck::Contains(&["gemini"]),
            Some("Gemini CLI 0.30.0")
        ));
        assert!(!confirms(AliasCheck::Contains(&["gemini"]), Some("0.30.0")));
        assert!(!confirms(AliasCheck::Contains(&["gemini"]), None));
    }

    #[test]
    fn agent_kind_names_roundtrip() {
        for kind in AgentKind::all() {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
            let back: AgentKind = serde_json::from_str(&json).unwrap();
            assert_eq!(back, kind);
        }
    }

    #[test]
    fn cli_update_output_marks_current() {
        assert!(cli_reports_current(
            "Checking for updates...\nAlready up to date"
        ));
        assert!(cli_reports_current("已是最新版本"));
        assert!(!cli_reports_current(""));
        assert!(!cli_reports_current("Latest version available: 2026.10.12"));
        assert!(!cli_reports_current("not up to date"));
        assert!(!cli_reports_current("Update failed: network"));
        assert!(update_failed("Update failed: Couldn't check for updates"));
    }

    #[test]
    fn cursor_version_keeps_the_build_suffix() {
        assert_eq!(
            version_from_output("2026.10.01-e373342\n", ""),
            Some("2026.10.01-e373342".into())
        );
        assert_eq!(
            version_from_output("2.1.292 (Claude Code)\n", ""),
            Some("2.1.292".into())
        );
        assert_eq!(
            command_label(Path::new(r"C:\agent\agent.cmd"), &["update"]),
            "agent update"
        );
    }

    #[test]
    fn quotes_windows_command_paths() {
        let line = windows_cmd_line(
            Path::new(r"C:\Program Files\nodejs\npm.cmd"),
            &["view", "@openai/codex", "version"],
        );
        assert_eq!(
            line,
            r#""C:\Program Files\nodejs\npm.cmd" view @openai/codex version"#
        );
        assert_eq!(
            cmd_invocation_line(
                Path::new(r"C:\Program Files\nodejs\npm.cmd"),
                &["view", "@openai/codex", "version"],
            ),
            "\"\"C:\\Program Files\\nodejs\\npm.cmd\" view @openai/codex version\""
        );
    }
}
