//! 每个 Agent 一份原生会话目录，供「导入 CLI 会话」和分叉用。

use async_trait::async_trait;

use aiwb_core::models::{AgentKind, SessionStatus};

/// 某个 Agent 能 resume 的一条原生会话。
#[derive(Debug, Clone)]
pub struct DirectoryEntry {
    pub native_id: String,
    /// 原始工作目录。
    pub cwd: String,
    pub cwd_key: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: SessionStatus,
    pub ephemeral: bool,
    /// `thread/list` 的 `archived`。侧栏不展示。
    pub archived: bool,
}

/// 列出 / 失效一个 Agent 的原生会话。
#[async_trait]
pub trait SessionDirectory: Send + Sync {
    fn kind(&self) -> AgentKind;

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String>;

    async fn invalidate(&self);
}
