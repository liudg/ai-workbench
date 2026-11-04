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

/// 某个项目目录下的一页原生会话，从新到旧。还有更早的就给 `next_cursor`，原样传回取下一页。
/// 一页可能不满，甚至是空的，只要有游标就还有。
#[derive(Debug, Clone, Default)]
pub struct DirectoryPage {
    pub entries: Vec<DirectoryEntry>,
    pub next_cursor: Option<String>,
}

/// 列出 / 失效一个 Agent 的原生会话。
#[async_trait]
pub trait SessionDirectory: Send + Sync {
    fn kind(&self) -> AgentKind;

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String>;

    async fn invalidate(&self);
}
