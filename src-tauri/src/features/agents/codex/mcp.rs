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
        apply_enabled(&codex_config_file(), &name, enabled)?;
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

fn apply_enabled(path: &Path, name: &str, enabled: bool) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|_| "找不到 Codex 的 MCP 配置。".to_string())?;
    let next = set_mcp_enabled(&text, name, enabled)?;
    write_config(path, &next)
}

/// 写到配置文件本身。`config.toml` 若是符号链接，则写解析后的目标，链接保留。
fn write_config(path: &Path, text: &str) -> Result<(), String> {
    let target = config_write_target(path)?;
    let mut tmp_name = target.as_os_str().to_owned();
    tmp_name.push(".wb-tmp");
    let tmp = PathBuf::from(tmp_name);
    std::fs::write(&tmp, text).map_err(|err| format!("无法写入 MCP 配置：{err}"))?;
    if let Err(err) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("无法写入 MCP 配置：{err}"));
    }
    Ok(())
}

fn config_write_target(path: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "找不到 Codex 的 MCP 配置。".to_string())?;
    if meta.file_type().is_symlink() {
        std::fs::canonicalize(path).map_err(|err| format!("无法写入 MCP 配置：{err}"))
    } else {
        Ok(path.to_path_buf())
    }
}

/// 只改目标服务器的 `enabled`。用 toml 结构定位，避免把数组里的 `[` 当成表头。
/// 改完会再解析一遍；结果读不回来就不返回文本，调用方因此不会写入。
pub(crate) fn set_mcp_enabled(text: &str, name: &str, enabled: bool) -> Result<String, String> {
    let mut doc = text
        .parse::<toml_edit::Document>()
        .map_err(|_| "Codex 的 MCP 配置无法读取。".to_string())?;
    {
        let servers = doc
            .as_table_mut()
            .get_mut("mcp_servers")
            .and_then(toml_edit::Item::as_table_like_mut)
            .ok_or_else(|| "配置里没有这个 MCP 服务器。".to_string())?;
        let server = servers
            .get_mut(name)
            .ok_or_else(|| "配置里没有这个 MCP 服务器。".to_string())?;
        assign_enabled(server, enabled)?;
    }
    // toml_edit 输出 LF。原文件若全是 CRLF，写回前还原，避免 Windows 配置被改成 LF。
    let rendered = match_newlines(text, &doc.to_string());
    let parsed = rendered
        .parse::<toml_edit::Document>()
        .map_err(|_| "改完的 MCP 配置无法读取。".to_string())?;
    if read_enabled(&parsed, name) != Some(enabled) || enabled_key_count(&parsed, name) != 1 {
        return Err("改完的 MCP 配置无法读取。".into());
    }
    Ok(rendered)
}

fn assign_enabled(server: &mut toml_edit::Item, enabled: bool) -> Result<(), String> {
    let Some(table) = server.as_table_like_mut() else {
        return Err("配置里没有这个 MCP 服务器。".into());
    };
    let item = table.entry("enabled").or_insert(toml_edit::value(enabled));
    let Some(value) = item.as_value_mut() else {
        return Err("enabled 不是布尔值。".into());
    };
    if value.as_array().is_some() || value.as_inline_table().is_some() {
        return Err("enabled 不是布尔值。".into());
    }
    let decor = value.decor().clone();
    let mut next = toml_edit::Value::from(enabled);
    *next.decor_mut() = decor;
    *value = next;
    Ok(())
}

fn read_enabled(doc: &toml_edit::Document, name: &str) -> Option<bool> {
    server_table(doc, name)?.get("enabled")?.as_bool()
}

fn enabled_key_count(doc: &toml_edit::Document, name: &str) -> usize {
    server_table(doc, name)
        .map(|table| table.iter().filter(|(key, _)| *key == "enabled").count())
        .unwrap_or(0)
}

fn match_newlines(original: &str, rendered: &str) -> String {
    if original.contains("\r\n") && !original.split("\r\n").any(|part| part.contains('\n')) {
        return rendered.replace('\n', "\r\n");
    }
    rendered.to_string()
}

fn server_table<'a>(
    doc: &'a toml_edit::Document,
    name: &str,
) -> Option<&'a dyn toml_edit::TableLike> {
    doc.get("mcp_servers")
        .and_then(toml_edit::Item::as_table_like)
        .and_then(|servers| servers.get(name))
        .and_then(toml_edit::Item::as_table_like)
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
    use std::path::{Path, PathBuf};

    use super::{apply_enabled, read_enabled, set_mcp_enabled};

    const SAMPLE: &str = "model = \"gpt-5\"\n\n[mcp_servers.alpha]\ncommand = \"cmd\"\nenabled_tools = [\"echo\"]\n\n[mcp_servers.beta]\nurl = \"https://example.invalid/mcp\"\nenabled = true\n\n[mcp_servers.beta.oauth]\nclient_id = \"cid\"\n";

    fn enabled_of(text: &str, name: &str) -> Option<bool> {
        let doc = text.parse::<toml_edit::Document>().expect("edited toml");
        read_enabled(&doc, name)
    }

    #[test]
    fn inserts_enabled_without_touching_siblings_or_enabled_tools() {
        let next = set_mcp_enabled(SAMPLE, "alpha", false).unwrap();
        assert!(next.contains("command = \"cmd\"\nenabled_tools = [\"echo\"]"));
        assert!(next.contains("[mcp_servers.beta]\nurl = \"https://example.invalid/mcp\"\nenabled = true"));
        assert!(next.contains("client_id = \"cid\""));
        assert_eq!(enabled_of(&next, "alpha"), Some(false));
        assert_eq!(enabled_of(&next, "beta"), Some(true));
        assert_eq!(next.matches("enabled = false").count(), 1);
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

    #[test]
    fn keeps_multiline_arrays_whose_lines_start_with_bracket() {
        let text = "\
[mcp_servers.alpha]
command = \"cmd\"
args = [
  [\"--flag\"],
  \"[mcp_servers.beta]\",
]
enabled = true # stay

[mcp_servers.beta]
enabled = true
url = \"https://example.invalid/mcp\"
";
        let next = set_mcp_enabled(text, "alpha", false).unwrap();
        assert!(next.contains("  [\"--flag\"],\n  \"[mcp_servers.beta]\","));
        assert!(next.contains("enabled = false # stay"));
        assert!(next.contains("[mcp_servers.beta]\nenabled = true\nurl = \"https://example.invalid/mcp\""));
        assert_eq!(enabled_of(&next, "alpha"), Some(false));
        assert_eq!(enabled_of(&next, "beta"), Some(true));
        assert_eq!(next.matches("enabled = ").count(), 2);
    }

    #[test]
    fn keeps_header_comments_and_spaced_headers() {
        let text = "\
# [mcp_servers.beta]
[ mcp_servers.alpha ] # header note
command = \"cmd\"
";
        let next = set_mcp_enabled(text, "alpha", false).unwrap();
        assert!(next.starts_with("# [mcp_servers.beta]\n"));
        assert!(next.contains("[ mcp_servers.alpha ] # header note\n"));
        assert!(next.contains("command = \"cmd\"\n"));
        assert_eq!(enabled_of(&next, "alpha"), Some(false));
        let doc = next.parse::<toml_edit::Document>().unwrap();
        assert!(doc
            .get("mcp_servers")
            .and_then(toml_edit::Item::as_table_like)
            .and_then(|servers| servers.get("beta"))
            .is_none());
    }

    #[test]
    fn updates_inline_tables_and_dotted_keys_without_a_second_enabled() {
        let inline = "[mcp_servers]\nalpha = { command = \"cmd\", enabled = true }\n";
        let next = set_mcp_enabled(inline, "alpha", false).unwrap();
        assert_eq!(next, "[mcp_servers]\nalpha = { command = \"cmd\", enabled = false }\n");
        assert_eq!(next.matches("enabled").count(), 1);

        let dotted = "mcp_servers.alpha.command = \"cmd\"\nmcp_servers.alpha.enabled = true # keep\n";
        let next = set_mcp_enabled(dotted, "alpha", false).unwrap();
        assert_eq!(
            next,
            "mcp_servers.alpha.command = \"cmd\"\nmcp_servers.alpha.enabled = false # keep\n"
        );
        assert_eq!(enabled_of(&next, "alpha"), Some(false));
        assert_eq!(next.matches("enabled").count(), 1);

        let missing = "mcp_servers.alpha.command = \"cmd\"\n";
        let next = set_mcp_enabled(missing, "alpha", true).unwrap();
        assert!(next.contains("mcp_servers.alpha.command = \"cmd\""));
        assert_eq!(enabled_of(&next, "alpha"), Some(true));
        assert_eq!(next.matches("enabled").count(), 1);
        assert!(!next.contains("[mcp_servers.alpha]"));
    }

    #[test]
    fn refuses_duplicate_keys_and_leaves_invalid_files_unwritten() {
        let dup = "[mcp_servers.alpha]\nenabled = true\nenabled = false\n";
        assert!(set_mcp_enabled(dup, "alpha", true).is_err());

        let dir = std::env::temp_dir().join(format!("wb-mcp-invalid-{}", std::process::id()));
        let _guard = RmDir(dir.clone());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        let original = "not toml [\n";
        std::fs::write(&path, original).unwrap();
        assert!(apply_enabled(&path, "alpha", false).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn write_config_updates_symlink_target_and_keeps_the_link() {
        let dir = std::env::temp_dir().join(format!("wb-mcp-link-{}", std::process::id()));
        let _guard = RmDir(dir.clone());
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("real.toml");
        let link = dir.join("config.toml");
        std::fs::write(&target, "[mcp_servers.alpha]\ncommand = \"cmd\"\n").unwrap();
        symlink_file(&target, &link).unwrap();
        apply_enabled(&link, "alpha", false).unwrap();
        let body = std::fs::read_to_string(&target).unwrap();
        assert!(body.contains("enabled = false"));
        assert!(body.contains("command = \"cmd\""));
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(!dir.join("real.toml.wb-tmp").exists());
        assert!(!dir.join("config.toml.wb-tmp").exists());
    }

    fn symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link)
        }
    }

    struct RmDir(PathBuf);

    impl Drop for RmDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
