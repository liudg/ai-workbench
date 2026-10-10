//! Claude Code 适配器（v1 桩实现）。
//!
//! 真实集成方案（下一步）：
//! - Claude Code 是交互式 TUI：用 `portable-pty` 挂伪终端运行 `claude`，
//!   解析终端输出识别提问 / 审批界面；
//! - 或使用其 SDK / `--print` + stream-json 模式（`claude -p --output-format stream-json`），
//!   与 codex 类似地消费 JSONL 事件流，权限模式用 `--permission-prompt-tool`
//!   或 MCP 权限回调承接本应用的 needs-input 流程；
//! - `detect()` 执行 `claude --version` 探测安装与版本；
//! - 工作目录设为 `ctx.project_path`；认证交给 CLI 自身（ANTHROPIC_API_KEY
//!   或已登录的 claude.ai 会话），应用不存储任何密钥。

use std::sync::Arc;

use async_trait::async_trait;

use crate::models::AgentKind;

use super::stub::{StubAgentSession, StubPersona};
use super::{AgentAdapter, AgentSession, AgentError, EventSink, SessionContext};

pub struct ClaudeCodeAdapter {
    persona: StubPersona,
}

impl Default for ClaudeCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeCodeAdapter {
    pub fn new() -> Self {
        Self {
            persona: StubPersona {
                cli_label: "Claude Code",
                bin_name: "claude",
            },
        }
    }
}

#[async_trait]
impl AgentAdapter for ClaudeCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        // TODO(real): 替换为 `claude -p --output-format stream-json` 或 portable-pty，
        // 工作目录 = ctx.project_path，输出事件映射为 SessionEventBody 推入 events。
        let session = StubAgentSession::new(self.persona, events.clone());
        let _ = events.send(crate::models::SessionEventBody::System {
            text: format!(
                "Claude Code 会话已就绪（桩模式 · 目录 {}）",
                ctx.project_path
            ),
        });
        // 启动即就绪：进入等待输入的空闲态
        let _ = events.send(crate::models::SessionEventBody::StatusChanged {
            status: crate::models::SessionStatus::Completed,
        });
        Ok(Arc::new(session))
    }
}
