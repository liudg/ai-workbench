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

pub fn spawn(program: &Path, project: &Path) -> Result<Child, AgentError> {
    let mut command = Command::new(program);
    command
        .arg("acp")
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
