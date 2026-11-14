//! 拉起 `agy acp`。不经 shell。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, Command};

use crate::install::locate_release;
use crate::AgentError;
use aiwb_proc::apply_utf8_env;

/// 只认 `agy`。`antigravity` 是 IDE 的启动器，停更的 `gemini` 没有这套 ACP。
pub fn resolve() -> Result<PathBuf, AgentError> {
    locate_release(&super::release())
        .filter(|path| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem.eq_ignore_ascii_case("agy"))
        })
        .ok_or_else(|| AgentError::Runtime("未找到 Antigravity CLI（agy）。请先安装并运行 `agy` 登录。".into()))
}

/// 工作台拉起的每个 `agy` 都带上：不让它自己起后台自更新进程。
///
/// 2026-11-14 agy 1.5.9：会话、`-p /usage`、`mcp` 这些调用启动时会按 `last_check.timestamp` 节流，
/// 到点就 `auto_updater.go` 起一个脱离的更新进程，它再拉起的 `agy.exe` 自己开一个可见的控制台，
/// 在 Windows 上就是发消息时闪过的黑窗口。值必须是 `true`（`1` 不认），日志会写
/// `Auto-update disabled via environment variable AGY_CLI_DISABLE_AUTO_UPDATE`。
/// 升级走工作台的 `agy update`，用户自己在终端里跑的 `agy` 照常自更新。`--version` 不检查更新。
pub(crate) const NO_SELF_UPDATE: [(&str, &str); 1] = [("AGY_CLI_DISABLE_AUTO_UPDATE", "true")];

pub fn spawn(program: &Path, project: &Path) -> Result<Child, AgentError> {
    let mut command = Command::new(program);
    command
        .arg("acp")
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(NO_SELF_UPDATE)
        .kill_on_drop(true);
    apply_utf8_env(&mut command);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 宿主拉起控制台程序时不要弹出黑窗口。
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|err| {
        AgentError::Runtime(format!("无法启动 Antigravity（{}）：{err}", program.display()))
    })
}
