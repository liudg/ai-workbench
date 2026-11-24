//! 拉起 `agy acp`。不经 shell。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, Command};

use crate::install::locate_release;
use crate::instance::InstanceOverlay;
use crate::AgentError;
use aiwb_proc::{apply_utf8_env, hide_console};

/// 只认 `agy`。`antigravity` 是 IDE 的启动器，停更的 `gemini` 没有这套 ACP。
pub fn resolve() -> Result<PathBuf, AgentError> {
    locate_release(&super::release())
        .filter(|path| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem.eq_ignore_ascii_case("agy"))
        })
        .ok_or_else(|| {
            AgentError::Runtime(
                "未找到 Antigravity CLI（agy）。请先安装并运行 `agy` 登录。".into(),
            )
        })
}

pub fn resolve_bin_for(overlay: &InstanceOverlay) -> Result<PathBuf, AgentError> {
    if let Some(custom) = overlay.binary_path.as_ref() {
        if !custom.is_file() {
            return Err(AgentError::Runtime(format!(
                "配置的 Antigravity CLI 路径不存在：{}",
                custom.display()
            )));
        }
        return Ok(custom.clone());
    }
    resolve()
}

/// 工作台拉起的每个 `agy` 都带上：不让它自己起后台自更新进程。
pub(crate) const NO_SELF_UPDATE: [(&str, &str); 1] = [("AGY_CLI_DISABLE_AUTO_UPDATE", "true")];

pub fn apply_instance_env(command: &mut Command, overlay: &InstanceOverlay) {
    if overlay.is_isolated() {
        command.env_remove("ANTIGRAVITY_GEMINI_DIR");
        command.env_remove("AGY_ACCOUNT");
    }
    if let Some(home) = overlay.home_path.as_ref() {
        let _ = std::fs::create_dir_all(home);
        command.env("ANTIGRAVITY_GEMINI_DIR", home);
    }
    overlay.apply_env(command);
}

pub fn spawn(
    program: &Path,
    project: &Path,
    overlay: &InstanceOverlay,
) -> Result<Child, AgentError> {
    let mut command = Command::new(program);
    command
        .args(&overlay.launch_args)
        .arg("acp")
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(NO_SELF_UPDATE)
        .kill_on_drop(true);
    apply_instance_env(&mut command, overlay);
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    command.spawn().map_err(|err| {
        AgentError::Runtime(format!("无法启动 Antigravity（{}）：{err}", program.display()))
    })
}
