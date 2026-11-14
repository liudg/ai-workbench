//! 各 Agent 自己的 MCP 命令。界面只读 [`McpSurface`]，不按名字分支。

pub(crate) mod args;
pub(crate) mod exec;
pub(crate) mod parse;
pub(crate) mod surface;

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

use aiwb_core::models::{McpAddSpec, McpServerRow, McpSurface};

pub use surface::unverified;

#[async_trait]
pub trait McpDriver: Send + Sync {
    fn surface(&self, installed: bool) -> McpSurface;
    async fn list(&self) -> Result<Vec<McpServerRow>, String>;
    async fn add(&self, spec: &McpAddSpec) -> Result<String, String>;
    async fn remove(&self, name: &str, scope: &str) -> Result<String, String>;
    async fn login(&self, name: &str, registration: &str, scopes: &str) -> Result<String, String>;
    async fn logout(&self, name: &str) -> Result<String, String>;
    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<String, String>;
    async fn list_tools(&self, _name: &str) -> Result<String, String> {
        Err("该 CLI 没有 mcp list-tools。".into())
    }
}

pub struct AntigravityMcp;

#[async_trait]
impl McpDriver for AntigravityMcp {
    fn surface(&self, installed: bool) -> McpSurface {
        surface::antigravity(installed)
    }

    async fn list(&self) -> Result<Vec<McpServerRow>, String> {
        let text = run_agy(args::cursor_list(), exec::LIST_LIMIT).await?;
        Ok(parse::parse_antigravity_list(&text))
    }

    async fn add(&self, spec: &McpAddSpec) -> Result<String, String> {
        run_agy(args::antigravity_add(spec)?, exec::MUTATE_LIMIT).await
    }

    async fn remove(&self, name: &str, _scope: &str) -> Result<String, String> {
        run_agy(args::antigravity_remove(name)?, exec::MUTATE_LIMIT).await
    }

    async fn login(&self, _name: &str, _registration: &str, _scopes: &str) -> Result<String, String> {
        Err("agy mcp 没有 login。".into())
    }

    async fn logout(&self, _name: &str) -> Result<String, String> {
        Err("agy mcp 没有 logout。".into())
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<String, String> {
        run_agy(args::cursor_enabled(name, enabled)?, exec::MUTATE_LIMIT).await
    }
}

async fn run_agy(args: Vec<String>, limit: Duration) -> Result<String, String> {
    let bin = crate::antigravity_bin().ok_or_else(|| "未找到 Antigravity CLI（agy）。".to_string())?;
    let captured = exec::run_cli_with_env(&bin, &args, &crate::antigravity::NO_SELF_UPDATE, limit).await?;
    exec::success_stdout(captured)
}

pub struct CursorMcp;

#[async_trait]
impl McpDriver for CursorMcp {
    fn surface(&self, installed: bool) -> McpSurface {
        surface::cursor(installed)
    }

    async fn list(&self) -> Result<Vec<McpServerRow>, String> {
        let text = run(args::cursor_list(), exec::LIST_LIMIT).await?;
        Ok(parse::parse_cursor_list(&text))
    }

    async fn add(&self, _spec: &McpAddSpec) -> Result<String, String> {
        args::cursor_add_rejected().map(|_| String::new())
    }

    async fn remove(&self, _name: &str, _scope: &str) -> Result<String, String> {
        args::cursor_remove_rejected().map(|_| String::new())
    }

    async fn login(&self, name: &str, registration: &str, scopes: &str) -> Result<String, String> {
        if !registration.trim().is_empty() || !scopes.trim().is_empty() {
            return Err("这个 Agent 的 login 不接受注册策略或 scope。".into());
        }
        let captured = exec::run_cli(&bin()?, &args::cursor_login(name)?, exec::LOGIN_LIMIT).await?;
        exec::success_text(captured)
    }

    async fn logout(&self, _name: &str) -> Result<String, String> {
        Err("agent mcp 没有 logout。".into())
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<String, String> {
        run(args::cursor_enabled(name, enabled)?, exec::MUTATE_LIMIT).await
    }

    async fn list_tools(&self, name: &str) -> Result<String, String> {
        run(args::cursor_list_tools(name)?, exec::LIST_LIMIT).await
    }
}

async fn run(args: Vec<String>, limit: Duration) -> Result<String, String> {
    let captured = exec::run_cli(&bin()?, &args, limit).await?;
    exec::success_stdout(captured)
}

fn bin() -> Result<PathBuf, String> {
    exec::require_bin(
        crate::install::locate_cursor_agent(),
        "未找到 Cursor Agent。",
    )
}
