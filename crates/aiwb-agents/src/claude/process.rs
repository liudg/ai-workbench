//! 直接拉起 `claude` 二进制。不经 shell。
//!
//! Windows 上拒绝 `.cmd` / `.bat` / `.ps1`（Python SDK `_reject_windows_batch_cli`）。
//! 同目录有 `claude.exe` 时用那个。`CREATE_NO_WINDOW` 与 Codex 的 `hide_console` 相同，
//! 这里复制那四行，不改 Codex 源文件。
//!
//! 环境：去掉 `CLAUDECODE`，设置 `CLAUDE_CODE_ENTRYPOINT=cli`
//! （对齐原生交互式 TUI；原生 --print 默认会自设 sdk-cli。身份句仍由 isNonInteractive 决定）。
//! 不设置 `CLAUDE_AGENT_SDK_VERSION`。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, Command};

use aiwb_proc::{apply_utf8_env, hide_console};
use crate::install::{locate_release, CliRelease};
use crate::instance::InstanceOverlay;
use crate::AgentError;

const CLAUDE_HOST_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_DESKTOP_APP_VERSION",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CLAUDE_AGENT_SDK_VERSION",
];

const CLAUDE_ISOLATED_AUTH_VARS: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

pub fn resolve_claude_bin() -> Result<PathBuf, AgentError> {
    let release = CliRelease {
        bins: &["claude"],
        npm_package: "@anthropic-ai/claude-code",
        self_update: &["update"],
        locate: None,
        version_args: &[],
        aliases: &[],
        note: "",
    };
    let path = locate_release(&release).ok_or_else(|| {
        AgentError::Runtime("未找到 Claude Code。请先安装并确保 `claude` 在 PATH 中。".into())
    })?;
    prefer_native(path)
}

pub fn resolve_bin_for(overlay: &InstanceOverlay) -> Result<PathBuf, AgentError> {
    if let Some(custom) = overlay.binary_path.as_ref() {
        if !custom.is_file() {
            return Err(AgentError::Runtime(format!(
                "配置的 Claude Code 路径不存在：{}",
                custom.display()
            )));
        }
        return prefer_native(custom.clone());
    }
    resolve_claude_bin()
}

pub fn apply_instance_env(command: &mut Command, overlay: &InstanceOverlay) {
    for var in CLAUDE_HOST_SESSION_VARS {
        command.env_remove(var);
    }
    command.env("CLAUDE_CODE_ENTRYPOINT", "cli");
    if overlay.is_isolated() {
        for var in CLAUDE_ISOLATED_AUTH_VARS {
            command.env_remove(var);
        }
    }
    if let Some(home) = overlay.home_path.as_ref() {
        let _ = std::fs::create_dir_all(home);
        command.env("CLAUDE_CONFIG_DIR", home);
    }
    overlay.apply_env(command);
}

pub fn prefer_native(path: PathBuf) -> Result<PathBuf, AgentError> {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "cmd" && ext != "bat" && ext != "ps1" {
        return Ok(path);
    }
    if let Some(exe) = sibling_exe(&path) {
        return Ok(exe);
    }
    Err(AgentError::Runtime(
        "找到的是 Windows 批处理包装，不能通过 shell 启动。请使用 claude.exe。".into(),
    ))
}

fn sibling_exe(shim: &Path) -> Option<PathBuf> {
    let renamed = shim.with_extension("exe");
    if renamed.is_file() {
        return Some(renamed);
    }
    let sibling = shim.parent()?.join("claude.exe");
    sibling.is_file().then_some(sibling)
}

pub fn spawn(
    bin: &Path,
    args: &[String],
    project: &Path,
    overlay: &InstanceOverlay,
) -> Result<Child, AgentError> {
    let mut command = Command::new(bin);
    command.args(&overlay.launch_args);
    command
        .args(args)
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_instance_env(&mut command, overlay);
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    command.spawn().map_err(|err| {
        AgentError::Runtime(format!("无法启动 Claude Code（{}）：{err}", bin.display()))
    })
}
