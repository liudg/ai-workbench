//! 定位 Codex 二进制、隐藏控制台窗口、读取 `--version`。

use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::features::agents::AgentError;

pub(in crate::features::agents::codex) fn resolve_codex_bin() -> Result<PathBuf, AgentError> {
    if let Some(path) = std::env::var_os("CODEX_BIN").map(PathBuf::from) {
        if path.is_file() {
            if let Some(found) = vendor_exe_near(&path) {
                return Ok(found);
            }
            return Ok(path);
        }
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let exe = dir.join("codex.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    #[cfg(not(windows))]
    let mut launcher = None;
    for dir in std::env::split_paths(&path_var) {
        for name in ["codex.cmd", "codex.ps1", "codex"] {
            let shim = dir.join(name);
            if !shim.is_file() {
                continue;
            }
            if let Some(found) = vendor_exe_near(&shim) {
                return Ok(found);
            }
            #[cfg(not(windows))]
            if launcher.is_none() && name == "codex" {
                launcher = Some(shim);
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let candidate = PathBuf::from(appdata)
            .join("npm/node_modules/@openai/codex")
            .join(platform_vendor_suffix().unwrap_or(""));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    // 原生包缺失时，Unix 上的 npm 启动脚本会自己报错，不在这里假装找到了二进制。
    #[cfg(not(windows))]
    if let Some(launcher) = launcher {
        return Ok(launcher);
    }
    Err(AgentError::Runtime(
        "未找到 Codex CLI。请先安装并确保 `codex` 在 PATH 中（例如 npm i -g @openai/codex）。"
            .into(),
    ))
}

/// 当前平台的 Codex 原生包，相对 `@openai/codex` 包目录。
/// 对照 `@openai/codex` 的 `bin/codex.js`（`PLATFORM_PACKAGE_BY_TARGET`）。
pub(in crate::features::agents::codex) fn platform_vendor_suffix() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Some("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe")
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        Some("node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some("node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex")
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Some("node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Some("node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some("node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
    }
    #[cfg(not(any(
        all(
            target_os = "windows",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
        all(
            target_os = "macos",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
    )))]
    {
        None
    }
}

pub(in crate::features::agents::codex) fn vendor_exe_near(shim: &Path) -> Option<PathBuf> {
    let suffix = platform_vendor_suffix()?;
    let mut roots = Vec::new();
    if let Some(parent) = shim.parent() {
        roots.push(parent.to_path_buf());
    }
    if let Ok(real) = std::fs::canonicalize(shim) {
        if let Some(parent) = real.parent() {
            if !roots.iter().any(|root| root == parent) {
                roots.push(parent.to_path_buf());
            }
        }
    }
    for start in roots {
        let mut dir = start;
        for _ in 0..8 {
            if let Some(found) = vendor_at(&dir, suffix) {
                return Some(found);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

fn vendor_at(dir: &Path, suffix: &str) -> Option<PathBuf> {
    [
        dir.join("node_modules/@openai/codex").join(suffix),
        dir.join("lib/node_modules/@openai/codex").join(suffix),
        dir.join(suffix),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

pub(in crate::features::agents::codex) fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 宿主拉起控制台程序时不要弹出黑窗口。
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

pub(in crate::features::agents::codex) async fn codex_version(bin: &Path) -> String {
    let mut command = Command::new(bin);
    command.arg("--version");
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    apply_utf8_env(&mut command);
    let Ok(output) = command.output().await else {
        return "未知版本".into();
    };
    version_label(&decode_child_bytes(&output.stdout))
}

/// 状态卡标题用的是 CLI 包版本（`v0.162.1`），`--version` 整行是 `codex-cli 0.162.1`。
pub(in crate::features::agents::codex) fn version_label(stdout: &str) -> String {
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return "未知版本".into();
    }
    crate::features::agents::install::extract_version(line).unwrap_or_else(|| line.to_string())
}
