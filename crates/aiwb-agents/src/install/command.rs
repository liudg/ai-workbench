//! 查找本机 CLI，并按超时捕获一次命令输出。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use aiwb_proc::{apply_utf8_env, decode_child_bytes};

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

#[cfg(any(windows, test))]
pub fn windows_cmd_line(bin: &Path, args: &[&str]) -> String {
    let mut parts = Vec::with_capacity(1 + args.len());
    parts.push(quote_cmd_arg(&bin.display().to_string()));
    for arg in args {
        parts.push(quote_cmd_arg(arg));
    }
    parts.join(" ")
}

pub(super) fn find_bin(names: &[&str]) -> Option<PathBuf> {
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

pub(super) async fn npm_lists_global(npm: &Path, package: &str) -> bool {
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

pub(super) struct Captured {
    pub(super) code: i32,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

pub(super) async fn run_captured(
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
#[cfg(any(windows, test))]
pub fn cmd_invocation_line(bin: &Path, args: &[&str]) -> String {
    format!("\"{}\"", windows_cmd_line(bin, args))
}

pub(crate) fn tool_command(bin: &Path, args: &[&str], npm_quiet: bool) -> Command {
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

#[cfg(windows)]
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

#[cfg(any(windows, test))]
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
