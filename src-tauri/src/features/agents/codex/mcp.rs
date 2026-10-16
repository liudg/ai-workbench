//! Codex CLI 的 `codex mcp`。配置留在 Codex 自己的目录，不写进别的 Agent。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use crate::features::agents::mcp::exec::{self, require_bin};
use crate::features::agents::mcp::{args, parse, surface, McpDriver};
use crate::models::{McpAddSpec, McpServerRow, McpSurface};

pub struct CodexMcp;

pub fn driver() -> Arc<dyn McpDriver> {
    Arc::new(CodexMcp)
}

#[async_trait]
impl McpDriver for CodexMcp {
    fn surface(&self, installed: bool) -> McpSurface {
        surface::codex(installed)
    }

    async fn list(&self) -> Result<Vec<McpServerRow>, String> {
        let stdout = stdout(args::codex_list(), exec::LIST_LIMIT).await?;
        parse::parse_codex_list(&stdout)
    }

    async fn add(&self, spec: &McpAddSpec) -> Result<String, String> {
        run(args::codex_add(spec)?, exec::MUTATE_LIMIT).await
    }

    async fn remove(&self, name: &str, scope: &str) -> Result<String, String> {
        if !scope.trim().is_empty() {
            return Err("codex mcp remove 没有 --scope。".into());
        }
        run(args::codex_remove(name)?, exec::MUTATE_LIMIT).await
    }

    async fn login(&self, name: &str, registration: &str, scopes: &str) -> Result<String, String> {
        let captured = exec::run_cli(
            &bin()?,
            &args::codex_login(name, registration, scopes)?,
            exec::LOGIN_LIMIT,
        )
        .await?;
        exec::success_text(captured)
    }

    async fn logout(&self, name: &str) -> Result<String, String> {
        run(args::codex_logout(name)?, exec::MUTATE_LIMIT).await
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<String, String> {
        let name = parse::require_name(name)?;
        let path = codex_config_file();
        let text = std::fs::read_to_string(&path).map_err(|_| "找不到 Codex 的 MCP 配置。".to_string())?;
        let next = set_mcp_enabled(&text, &name, enabled)?;
        write_config(&path, &next)?;
        Ok(if enabled {
            "已启用".into()
        } else {
            "已禁用".into()
        })
    }
}

fn codex_config_file() -> PathBuf {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| {
            let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
            match home {
                Some(home) => PathBuf::from(home).join(".codex"),
                None => PathBuf::from(".codex"),
            }
        });
    root.join("config.toml")
}

fn write_config(path: &Path, text: &str) -> Result<(), String> {
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".wb-tmp");
    let tmp = PathBuf::from(tmp_name);
    std::fs::write(&tmp, text).map_err(|err| format!("无法写入 MCP 配置：{err}"))?;
    std::fs::rename(&tmp, path).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        format!("无法写入 MCP 配置：{err}")
    })
}

/// 只改目标服务器表里的 `enabled`。没有 enable 子命令，配置字段就是开关。
pub(crate) fn set_mcp_enabled(text: &str, name: &str, enabled: bool) -> Result<String, String> {
    if name.contains(['"', '\'', '[', ']', '\\', '\n', '\r']) {
        return Err("名称不能包含引号或方括号。".into());
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let ends_with_newline = text.ends_with('\n');
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();
    if ends_with_newline && lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let bare = format!("[mcp_servers.{name}]");
    let quoted = format!("[mcp_servers.\"{name}\"]");
    let index = lines
        .iter()
        .position(|line| {
            let trimmed = line.trim();
            trimmed == bare || trimmed == quoted
        })
        .ok_or_else(|| "配置里没有这个 MCP 服务器。".to_string())?;
    let mut end = index + 1;
    while end < lines.len() && !lines[end].trim_start().starts_with('[') {
        end += 1;
    }
    let value = if enabled { "true" } else { "false" };
    let mut replaced = false;
    for line in &mut lines[index + 1..end] {
        if let Some(updated) = replace_enabled_line(line, value) {
            *line = updated;
            replaced = true;
            break;
        }
    }
    if !replaced {
        lines.insert(index + 1, format!("enabled = {value}"));
    }
    let mut out = lines.join(newline);
    if ends_with_newline {
        out.push_str(newline);
    }
    Ok(out)
}

fn replace_enabled_line(line: &str, value: &str) -> Option<String> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("enabled")?;
    let rest = rest.trim_start();
    if !rest.starts_with('=') {
        return None;
    }
    let indent_len = line.len() - line.trim_start().len();
    Some(format!("{}enabled = {value}", &line[..indent_len]))
}

async fn run(args: Vec<String>, limit: std::time::Duration) -> Result<String, String> {
    let captured = exec::run_cli(&bin()?, &args, limit).await?;
    exec::success_stdout(captured)
}

async fn stdout(args: Vec<String>, limit: std::time::Duration) -> Result<String, String> {
    let captured = exec::run_cli(&bin()?, &args, limit).await?;
    exec::ensure_ok(captured)
}

fn bin() -> Result<std::path::PathBuf, String> {
    require_bin(super::locate_codex_bin(), "未找到 Codex CLI。")
}

#[cfg(test)]
mod tests {
    use super::set_mcp_enabled;

    const SAMPLE: &str = "model = \"gpt-5\"\n\n[mcp_servers.alpha]\ncommand = \"cmd\"\nenabled_tools = [\"echo\"]\n\n[mcp_servers.beta]\nurl = \"https://example.invalid/mcp\"\nenabled = true\n\n[mcp_servers.beta.oauth]\nclient_id = \"cid\"\n";

    #[test]
    fn inserts_enabled_without_touching_siblings_or_enabled_tools() {
        let next = set_mcp_enabled(SAMPLE, "alpha", false).unwrap();
        assert!(next.contains("[mcp_servers.alpha]\nenabled = false\ncommand = \"cmd\"\nenabled_tools = [\"echo\"]"));
        assert!(next.contains("[mcp_servers.beta]\nurl = \"https://example.invalid/mcp\"\nenabled = true"));
        assert!(next.contains("client_id = \"cid\""));
        assert!(set_mcp_enabled(SAMPLE, "missing", true).unwrap_err().contains("没有这个 MCP"));
    }

    #[test]
    fn replaces_enabled_and_keeps_crlf_and_quoted_names() {
        let text = "[mcp_servers.\"wb accept\"]\r\ncommand = \"cmd\"\r\nenabled = true\r\n";
        let next = set_mcp_enabled(text, "beta", false);
        assert!(next.is_err());
        let quoted = "[mcp_servers.\"beta\"]\r\ncommand = \"cmd\"\r\n  enabled = true\r\n";
        let next = set_mcp_enabled(quoted, "beta", false).unwrap();
        assert_eq!(next, "[mcp_servers.\"beta\"]\r\ncommand = \"cmd\"\r\n  enabled = false\r\n");
    }
}
