//! 各 Agent 自己的 MCP 命令。界面只读 [`McpSurface`]，不按名字分支。

pub(crate) mod args;
pub(crate) mod exec;
pub(crate) mod parse;
pub(crate) mod surface;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use crate::instance::InstanceOverlay;
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

pub struct AntigravityMcp {
    pub overlay: Arc<InstanceOverlay>,
}

#[async_trait]
impl McpDriver for AntigravityMcp {
    fn surface(&self, installed: bool) -> McpSurface {
        surface::antigravity(installed)
    }

    async fn list(&self) -> Result<Vec<McpServerRow>, String> {
        let text = self.run_agy(args::cursor_list(), exec::LIST_LIMIT).await?;
        Ok(parse::parse_antigravity_list(&text))
    }

    async fn add(&self, spec: &McpAddSpec) -> Result<String, String> {
        self.run_agy(args::antigravity_add(spec)?, exec::MUTATE_LIMIT)
            .await
    }

    async fn remove(&self, name: &str, _scope: &str) -> Result<String, String> {
        self.run_agy(args::antigravity_remove(name)?, exec::MUTATE_LIMIT)
            .await
    }

    async fn login(&self, _name: &str, _registration: &str, _scopes: &str) -> Result<String, String> {
        Err("agy mcp 没有 login。".into())
    }

    async fn logout(&self, _name: &str) -> Result<String, String> {
        Err("agy mcp 没有 logout。".into())
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<String, String> {
        self.run_agy(args::cursor_enabled(name, enabled)?, exec::MUTATE_LIMIT)
            .await
    }
}

impl AntigravityMcp {
    async fn run_agy(&self, args: Vec<String>, limit: Duration) -> Result<String, String> {
        let bin = crate::antigravity::resolve_bin_for(&self.overlay).map_err(|e| e.to_string())?;
        let overlay = Arc::clone(&self.overlay);
        let captured = exec::run_cli_configured(&bin, &args, limit, move |cmd| {
            cmd.envs(crate::antigravity::NO_SELF_UPDATE);
            crate::antigravity::apply_instance_env(cmd, &overlay);
        })
        .await?;
        exec::success_stdout(captured)
    }
}

pub struct CursorMcp {
    pub overlay: Arc<InstanceOverlay>,
}

#[async_trait]
impl McpDriver for CursorMcp {
    fn surface(&self, installed: bool) -> McpSurface {
        surface::cursor(installed)
    }

    async fn list(&self) -> Result<Vec<McpServerRow>, String> {
        let text = self.run(args::cursor_list(), exec::LIST_LIMIT).await?;
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
        let captured = self
            .run_captured(args::cursor_login(name)?, exec::LOGIN_LIMIT)
            .await?;
        exec::success_text(captured)
    }

    async fn logout(&self, _name: &str) -> Result<String, String> {
        Err("agent mcp 没有 logout。".into())
    }

    async fn set_enabled(&self, name: &str, enabled: bool) -> Result<String, String> {
        self.run(args::cursor_enabled(name, enabled)?, exec::MUTATE_LIMIT)
            .await
    }

    async fn list_tools(&self, name: &str) -> Result<String, String> {
        self.run(args::cursor_list_tools(name)?, exec::LIST_LIMIT)
            .await
    }
}

impl CursorMcp {
    async fn run_captured(
        &self,
        args: Vec<String>,
        limit: Duration,
    ) -> Result<exec::Captured, String> {
        let launcher = crate::cursor::resolve_for(&self.overlay).map_err(|e| e.to_string())?;
        let mut full_args = launcher.prefix;
        full_args.extend(args);
        let overlay = Arc::clone(&self.overlay);
        exec::run_cli_configured(&launcher.program, &full_args, limit, move |cmd| {
            crate::cursor::apply_instance_env(cmd, &overlay);
        })
        .await
    }

    async fn run(&self, args: Vec<String>, limit: Duration) -> Result<String, String> {
        let captured = self.run_captured(args, limit).await?;
        exec::success_stdout(captured)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn custom_missing_binary_fails_explicitly_without_falling_back_to_host_cli() {
        let missing = PathBuf::from("nonexistent-dir-9f8e7d/missing-binary-exe");
        let agy_mcp = AntigravityMcp {
            overlay: Arc::new(InstanceOverlay {
                instance_id: "agy-custom".into(),
                binary_path: Some(missing.clone()),
                ..Default::default()
            }),
        };
        let agy_err = agy_mcp.list().await.expect_err("must fail on missing binary");
        assert!(agy_err.contains("路径不存在"), "unexpected error: {agy_err}");

        let cursor_mcp = CursorMcp {
            overlay: Arc::new(InstanceOverlay {
                instance_id: "cursor-custom".into(),
                binary_path: Some(missing),
                ..Default::default()
            }),
        };
        let cursor_err = cursor_mcp
            .list()
            .await
            .expect_err("must fail on missing binary");
        assert!(
            cursor_err.contains("路径不存在"),
            "unexpected error: {cursor_err}"
        );
    }
}
