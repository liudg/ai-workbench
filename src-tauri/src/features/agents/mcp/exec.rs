//! 拉起某个 Agent 自己的 CLI。不读、不写另一家的配置。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::encoding::{apply_utf8_env, decode_child_bytes};

#[derive(Debug)]
pub struct Captured {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn text_of(captured: &Captured) -> String {
    let stderr = captured.stderr.trim();
    let stdout = captured.stdout.trim();
    if !stderr.is_empty() && !stdout.is_empty() {
        format!("{stdout}\n{stderr}")
    } else if !stdout.is_empty() {
        stdout.to_string()
    } else {
        stderr.to_string()
    }
}

pub const LIST_LIMIT: Duration = Duration::from_secs(60);
pub const MUTATE_LIMIT: Duration = Duration::from_secs(30);
pub const LOGIN_LIMIT: Duration = Duration::from_secs(180);

pub fn success_stdout(captured: Captured) -> Result<String, String> {
    let stdout = ensure_ok(captured)?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        Ok("已完成".into())
    } else {
        Ok(trimmed.to_string())
    }
}

/// 登录可能把网址打在 stderr。退出码 0 时两边都返回。
pub fn success_text(captured: Captured) -> Result<String, String> {
    if captured.code != 0 {
        return Err(failure(&captured));
    }
    let text = text_of(&captured);
    if text.trim().is_empty() {
        Ok("已完成".into())
    } else {
        Ok(text)
    }
}

fn failure(captured: &Captured) -> String {
    let text = text_of(captured);
    if text.is_empty() {
        format!("退出码 {}", captured.code)
    } else {
        text
    }
}

pub fn ensure_ok(captured: Captured) -> Result<String, String> {
    if captured.code == 0 {
        return Ok(captured.stdout);
    }
    Err(failure(&captured))
}

pub async fn run_cli(bin: &Path, args: &[String], limit: Duration) -> Result<Captured, String> {
    let mut command = script_command(bin, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(std::env::temp_dir());
    hide_console(&mut command);
    apply_utf8_env(&mut command);
    command.env_remove("CLAUDECODE");
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

pub fn require_bin(path: Option<PathBuf>, missing: &str) -> Result<PathBuf, String> {
    path.filter(|path| path.is_file())
        .ok_or_else(|| missing.to_string())
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

#[cfg(windows)]
fn script_command(bin: &Path, args: &[String]) -> Command {
    let ext = bin
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "cmd" || ext == "bat" {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut command = Command::new("cmd");
        command.arg("/D").arg("/S").arg("/C");
        command.raw_arg(crate::features::agents::install::cmd_invocation_line(
            bin, &refs,
        ));
        command
    } else {
        let mut command = Command::new(bin);
        command.args(args);
        command
    }
}

#[cfg(not(windows))]
fn script_command(bin: &Path, args: &[String]) -> Command {
    let mut command = Command::new(bin);
    command.args(args);
    command
}
