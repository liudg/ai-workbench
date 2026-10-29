//! 拉起 `agent acp`。不经 shell。
//!
//! Windows 上官方入口是 `%LOCALAPPDATA%\cursor-agent\agent.cmd`，它经 `cursor-agent.ps1`
//! 选出 `versions\` 下日期最新的目录，再跑那里的 `node.exe index.js`。这里照
//! `cursor-agent.ps1` 的 `Parse-VersionString` 和目录名规则直接找到 node.exe，不起 cmd / PowerShell。
//! 其它系统上 `agent` 本身就能直接执行。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, Command};

use aiwb_proc::apply_utf8_env;
use crate::install::locate_release;
use crate::AgentError;

/// 可执行文件和要放在 `acp` 前面的参数。
pub struct Launcher {
    pub program: PathBuf,
    pub prefix: Vec<String>,
}

pub fn resolve() -> Result<Launcher, AgentError> {
    let found = locate_release(&super::release()).ok_or_else(|| {
        AgentError::Runtime("未找到 Cursor Agent。请先安装并运行 `agent login`。".into())
    })?;
    let ext = found
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "cmd" && ext != "bat" && ext != "ps1" {
        return Ok(Launcher {
            program: found,
            prefix: Vec::new(),
        });
    }
    let root = found
        .parent()
        .ok_or_else(|| AgentError::Runtime("Cursor Agent 安装目录不完整".into()))?;
    let version = latest_version_dir(&root.join("versions")).ok_or_else(|| {
        AgentError::Runtime("Cursor Agent 安装目录里没有可用版本".into())
    })?;
    let node = version.join("node.exe");
    let index = version.join("index.js");
    if !node.is_file() || !index.is_file() {
        return Err(AgentError::Runtime(format!(
            "Cursor Agent 版本目录不完整：{}",
            version.display()
        )));
    }
    Ok(Launcher {
        program: node,
        prefix: vec![index.to_string_lossy().to_string()],
    })
}

/// `YYYY.MM.DD-commit` 或 `YYYY.MM.DD-HH-MM-SS-commit`。按日期取最新，同一天再按名字。
pub fn latest_version_dir(versions: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(versions).ok()?;
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            version_key(&name).map(|key| (key, name, entry.path()))
        })
        .max_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)))
        .map(|(_, _, path)| path)
}

pub fn version_key(name: &str) -> Option<u32> {
    let (date, rest) = name.split_once('-')?;
    let commit = rest.rsplit('-').next()?;
    if commit.is_empty() || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let stamp: Vec<&str> = rest.split('-').collect();
    if stamp.len() != 1 && stamp.len() != 4 {
        return None;
    }
    if !stamp[..stamp.len() - 1]
        .iter()
        .all(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let parts: Vec<&str> = date.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let year: u32 = parts[0].parse().ok().filter(|_| parts[0].len() == 4)?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;
    Some(year * 10000 + month * 100 + day)
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 宿主拉起控制台程序时不要弹出黑窗口。
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

pub fn spawn(launcher: &Launcher, project: &Path) -> Result<Child, AgentError> {
    let mut command = Command::new(&launcher.program);
    command
        .args(&launcher.prefix)
        .arg("acp")
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if std::env::var_os("NODE_COMPILE_CACHE").is_none() {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            // `cursor-agent.ps1` 同样设置，启动快一些。
            command.env(
                "NODE_COMPILE_CACHE",
                PathBuf::from(local).join("cursor-compile-cache"),
            );
        }
    }
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    command.spawn().map_err(|err| {
        AgentError::Runtime(format!(
            "无法启动 Cursor Agent（{}）：{err}",
            launcher.program.display()
        ))
    })
}
