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

use crate::encoding::apply_utf8_env;
use crate::features::agents::install::{locate_release, CliRelease};
use crate::features::agents::AgentError;

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

pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 宿主拉起控制台程序时不要弹出黑窗口。
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

pub fn spawn(bin: &Path, args: &[String], project: &Path) -> Result<Child, AgentError> {
    let mut command = Command::new(bin);
    command
        .args(args)
        .current_dir(project)
        .env_remove("CLAUDECODE")
        .env("CLAUDE_CODE_ENTRYPOINT", "cli")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    command.spawn().map_err(|err| {
        AgentError::Runtime(format!("无法启动 Claude Code（{}）：{err}", bin.display()))
    })
}
