//! Codex CLI 的 `codex mcp`。配置留在 Codex 自己的目录，不写进别的 Agent。

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

    async fn set_enabled(&self, _name: &str, _enabled: bool) -> Result<String, String> {
        Err("codex mcp 没有 enable 或 disable。list JSON 里的 enabled 不能改。".into())
    }
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
