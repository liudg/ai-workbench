//! 本机 Agent CLI 的探测与官方升级。
//!
//! 适配器只声明发布信息（二进制名、npm 包、非 npm 安装时的自更新参数）。
//! 设置页和新建会话消费 `AgentInstallation`，不比较 Agent 种类。
//!
//! 有 npm 包时，版本对照走 `npm view <pkg> version`。升级按安装方式分流：
//! 全局 npm 安装执行 `npm install -g <pkg>@latest`；否则执行该二进制声明的
//! 官方自更新参数。没有 npm 包时，已安装且声明了自更新就提供更新，不查询 registry。
//! 工作台不代为安装缺失的 CLI。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::models::{AgentInstallation, AgentKind, UpdateVia};

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
    Contains(&'static [&'static str]),
    /// Amazon Q / Kiro 的 `q`：输出版本里出现 Kiro 或 Amazon Q，
    /// 或者首行是 `q 1.2.3` 这种官方短版本行。
    AmazonQ,
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
        AliasCheck::AmazonQ => text.is_some_and(confirms_amazon_q),
    }
}

fn confirms_amazon_q(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if ["kiro", "amazon q", "amazon-q", "q developer"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return true;
    }
    let Some(line) = first_line(text) else {
        return false;
    };
    let Some(rest) = line.strip_prefix('q').or_else(|| line.strip_prefix('Q')) else {
        return false;
    };
    let rest = rest.trim();
    extract_version(rest).is_some() && line.chars().count() < 40 && !rest.contains(' ')
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

    let update_available = if tracks_npm {
        match (&latest_version, &chosen.version) {
            (Some(latest), Some(current)) => is_newer(latest, current),
            _ => false,
        }
    } else {
        chosen.can_update
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
    let outcome = match via {
        UpdateVia::Npm => {
            if release.npm_package.is_empty() {
                return Err(format!("{display_name} 没有 npm 包，不能按 npm 升级。"));
            }
            let npm =
                find_bin(&["npm"]).ok_or_else(|| "未找到 npm，无法按官方方式升级。".to_string())?;
            let spec = format!("{}@latest", release.npm_package);
            run_captured(
                &npm,
                &["install", "-g", &spec, "--no-fund", "--no-audit"],
                Duration::from_secs(180),
                true,
            )
            .await
        }
        UpdateVia::Cli => {
            if chosen.update_args.is_empty() {
                return Err(format!("{display_name} 没有官方更新入口"));
            }
            run_captured(&bin, chosen.update_args, Duration::from_secs(180), false).await
        }
    };

    match outcome {
        Ok(captured) if captured.code == 0 => {
            Ok(inspect_release(kind, display_name, release).await)
        }
        Ok(captured) => Err(clip(
            &format!(
                "升级失败（退出码 {}）：{}",
                captured.code,
                failure_text(&captured)
            ),
            400,
        )),
        Err(err) => Err(err),
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

pub fn extract_version(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index].is_ascii_digit() {
            if let Some((version, _)) = take_semver(&chars, index) {
                return Some(version);
            }
        }
        index += 1;
    }
    None
}

pub fn parse_published_version(stdout: &str) -> Option<String> {
    for line in stdout.lines().rev() {
        let line = line.trim().trim_matches('"');
        let Some(version) = extract_version(line) else {
            continue;
        };
        if version == line || line.strip_prefix('v') == Some(version.as_str()) {
            return Some(version);
        }
    }
    None
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    let latest_parts = version_core(latest);
    let current_parts = version_core(current);
    if latest_parts.is_empty() || current_parts.is_empty() {
        return false;
    }
    let width = latest_parts.len().max(current_parts.len());
    for index in 0..width {
        let next = latest_parts.get(index).copied().unwrap_or(0);
        let prev = current_parts.get(index).copied().unwrap_or(0);
        if next != prev {
            return next > prev;
        }
    }
    false
}

pub fn tool_file_names(name: &str) -> Vec<String> {
    if cfg!(windows) && !name.contains('.') {
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    }
}

pub fn windows_cmd_line(bin: &Path, args: &[&str]) -> String {
    let mut parts = Vec::with_capacity(1 + args.len());
    parts.push(quote_cmd_arg(&bin.display().to_string()));
    for arg in args {
        parts.push(quote_cmd_arg(arg));
    }
    parts.join(" ")
}

fn version_core(version: &str) -> Vec<u64> {
    let core = version.split(['-', '+']).next().unwrap_or(version);
    core.split('.')
        .filter_map(|part| part.parse().ok())
        .collect()
}

fn take_semver(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut index = start;
    let mut dots = 0;
    let mut saw_digit = false;
    while index < chars.len() {
        let ch = chars[index];
        if ch.is_ascii_digit() {
            saw_digit = true;
            index += 1;
            continue;
        }
        if ch == '.' && saw_digit && dots < 2 {
            dots += 1;
            saw_digit = false;
            index += 1;
            continue;
        }
        break;
    }
    if dots != 2 || !saw_digit {
        return None;
    }
    Some((chars[start..index].iter().collect(), index))
}

fn version_from_output(stdout: &str, stderr: &str) -> Option<String> {
    let line = first_line(stdout).or_else(|| first_line(stderr))?;
    extract_version(&line).or(Some(line))
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn find_bin(names: &[&str]) -> Option<PathBuf> {
    let files: Vec<String> = names
        .iter()
        .flat_map(|name| tool_file_names(name))
        .collect();
    for dir in search_dirs() {
        for name in &files {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("npm"));
        dirs.push(local.join("AnthropicClaude"));
        dirs.push(local.join("Programs"));
        dirs.push(local.join("cursor-agent"));
        dirs.push(local.join("agy").join("bin"));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    if let Some(home) = home {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join(".codex").join("bin"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(program_files).join("nodejs"));
    }
    dirs
}

async fn npm_lists_global(npm: &Path, package: &str) -> bool {
    let Ok(captured) = run_captured(
        npm,
        &["list", "-g", package, "--depth=0", "--json"],
        Duration::from_secs(20),
        true,
    )
    .await
    else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&captured.stdout) else {
        return false;
    };
    value
        .get("dependencies")
        .and_then(|deps| deps.get(package))
        .and_then(|item| item.get("version"))
        .and_then(|version| version.as_str())
        .is_some()
}

struct Captured {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn run_captured(
    bin: &Path,
    args: &[&str],
    limit: Duration,
    npm_quiet: bool,
) -> Result<Captured, String> {
    let mut command = tool_command(bin, args, npm_quiet);
    let child = command
        .spawn()
        .map_err(|err| format!("无法启动 {}：{err}", bin.display()))?;
    match timeout(limit, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(Captured {
            code: output.status.code().unwrap_or(-1),
            stdout: decode_child_bytes(&output.stdout).into_owned(),
            stderr: decode_child_bytes(&output.stderr).into_owned(),
        }),
        Ok(Err(err)) => Err(format!("运行 {} 失败：{err}", bin.display())),
        Err(_) => Err(format!("运行 {} 超时", bin.display())),
    }
}

/// `cmd /C` 会剥掉首尾引号。路径里有空格时再包一层，剥完仍是带引号的可执行文件。
pub fn cmd_invocation_line(bin: &Path, args: &[&str]) -> String {
    format!("\"{}\"", windows_cmd_line(bin, args))
}

fn tool_command(bin: &Path, args: &[&str], npm_quiet: bool) -> Command {
    let mut command = script_command(bin, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(std::env::temp_dir());
    hide_console(&mut command);
    apply_utf8_env(&mut command);
    if npm_quiet {
        command.env("npm_config_update_notifier", "false");
        command.env("npm_config_fund", "false");
        command.env("npm_config_audit", "false");
        command.env("npm_config_yes", "true");
    } else if args.len() == 1 && args[0] == "update" {
        command.env("CODEX_NON_INTERACTIVE", "1");
    }
    command
}

#[cfg(windows)]
fn script_command(bin: &Path, args: &[&str]) -> Command {
    if is_script(bin) {
        let mut command = Command::new("cmd");
        command.arg("/D").arg("/S").arg("/C");
        command.raw_arg(cmd_invocation_line(bin, args));
        command
    } else {
        let mut command = Command::new(bin);
        command.args(args);
        command
    }
}

#[cfg(not(windows))]
fn script_command(bin: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(bin);
    command.args(args);
    command
}

fn is_script(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("cmd") | Some("bat")
    )
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

fn failure_text(captured: &Captured) -> String {
    let stderr = captured.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = captured.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    "没有输出".to_string()
}

fn quote_cmd_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quotes = arg
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, '"' | '&' | '|' | '<' | '>' | '^' | '%'));
    if !needs_quotes {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    for ch in arg.chars() {
        if ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn clip(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
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
    fn unrelated_q_is_not_kiro() {
        let release = CliRelease {
            bins: &["kiro-cli", "q"],
            npm_package: "",
            self_update: &["update", "--non-interactive"],
            locate: None,
            version_args: &["version"],
            aliases: &[AliasRule {
                name: "q",
                check: AliasCheck::AmazonQ,
                version_args: None,
                update_args: Some(&["update"]),
            }],
            note: "",
        };
        assert!(choose_bin(&release, &[hit("q", Some("usage: q is a query tool"))]).is_none());
        assert!(choose_bin(&release, &[hit("q", None)]).is_none());
        let legacy = choose_bin(&release, &[hit("q", Some("q 1.19.7"))]).expect("amazon q");
        assert_eq!(legacy.name, "q");
        assert_eq!(legacy.update_args, &["update"]);
        let kiro = choose_bin(
            &release,
            &[
                hit("kiro-cli", Some("kiro-cli 2.6.1")),
                hit("q", Some("Kiro CLI 2.6.1")),
            ],
        )
        .expect("kiro");
        assert_eq!(kiro.name, "kiro-cli");
        assert_eq!(kiro.update_args, &["update", "--non-interactive"][..]);
        assert_eq!(kiro.also, vec!["q".to_string()]);
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
