//! Claude Code 的 `claude mcp`。不读 Codex 的 config.toml。

use std::sync::Arc;

use async_trait::async_trait;

use crate::features::agents::mcp::exec::{self, require_bin};
use crate::features::agents::mcp::{args, parse, surface, McpDriver};
use crate::models::{McpAddSpec, McpServerRow, McpSurface};

pub struct ClaudeMcp;

pub fn driver() -> Arc<dyn McpDriver> {
    Arc::new(ClaudeMcp)
}

#[async_trait]
impl McpDriver for ClaudeMcp {
    fn surface(&self, installed: bool) -> McpSurface {
        surface::claude(installed)
    }

    async fn list(&self) -> Result<Vec<McpServerRow>, String> {
        let text = run(args::claude_list(), exec::LIST_LIMIT).await?;
        let mut rows = parse::parse_cli_list(&text);
        for row in &mut rows {
            if row.transport == "streamable_http" {
                row.transport = "http".into();
            }
        }
        Ok(rows)
    }

    async fn add(&self, spec: &McpAddSpec) -> Result<String, String> {
        run(args::claude_add(spec)?, exec::MUTATE_LIMIT).await
    }

    async fn remove(&self, name: &str, scope: &str) -> Result<String, String> {
        run(args::claude_remove(name, scope)?, exec::MUTATE_LIMIT).await
    }

    async fn login(&self, name: &str, registration: &str, scopes: &str) -> Result<String, String> {
        let captured = exec::run_cli(
            &bin()?,
            &args::claude_login(name, registration, scopes)?,
            exec::LOGIN_LIMIT,
        )
        .await?;
        exec::success_text(captured)
    }

    async fn logout(&self, name: &str) -> Result<String, String> {
        run(args::claude_logout(name)?, exec::MUTATE_LIMIT).await
    }

    async fn set_enabled(&self, _name: &str, _enabled: bool) -> Result<String, String> {
        Err("claude mcp 没有 enable 或 disable。".into())
    }
}

async fn run(args: Vec<String>, limit: std::time::Duration) -> Result<String, String> {
    let captured = exec::run_cli(&bin()?, &args, limit).await?;
    exec::success_stdout(captured)
}

fn bin() -> Result<std::path::PathBuf, String> {
    require_bin(
        super::process::resolve_claude_bin().ok(),
        "未找到 Claude Code。",
    )
}
