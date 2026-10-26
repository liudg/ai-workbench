//! `~/.claude/projects` 里的会话目录。列表来自 jsonl，不是现场编的。
//! 没有 cwd 的条目对不上侧边栏项目，这是文件里没写，不是隐藏。

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;

use super::history;
use crate::{DirectoryEntry, SessionDirectory};
use aiwb_core::models::cwd_key;
use aiwb_core::models::{AgentKind, SessionStatus};

pub struct ClaudeDirectory;

impl ClaudeDirectory {
    pub fn shared() -> Arc<Self> {
        static DIR: OnceLock<Arc<ClaudeDirectory>> = OnceLock::new();
        DIR.get_or_init(|| Arc::new(ClaudeDirectory)).clone()
    }
}

#[async_trait]
impl SessionDirectory for ClaudeDirectory {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String> {
        Ok(history::list_sessions()
            .into_iter()
            .map(|item| DirectoryEntry {
                native_id: item.session_id,
                cwd_key: cwd_key(&item.cwd),
                cwd: item.cwd,
                title: item.title,
                created_at: item.created_at,
                updated_at: item.updated_at,
                status: SessionStatus::Completed,
                ephemeral: false,
                archived: false,
            })
            .collect())
    }

    async fn invalidate(&self) {}
}
