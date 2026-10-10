//! Codex CLI 适配器（v1 桩实现）。
//!
//! 真实集成方案（下一步）：
//! - 优先使用 `codex exec --json`（非交互模式，stdout 输出 JSONL 事件流）：
//!   用 `tokio::process::Command` 启动，逐行解析 JSON 事件并映射为
//!   `SessionEventBody`（agent_message / tool_call / approval_request 等）；
//! - 审批类提问通过 CLI 的审批协议回写 stdin；
//! - `detect()` 执行 `codex --version` 探测安装与版本；
//! - 工作目录设为 `ctx.project_path`，环境变量继承并允许用户覆盖
//!   （如 `OPENAI_API_KEY`，绝不写死在代码里）。

use std::sync::Arc;

use async_trait::async_trait;

use crate::models::AgentKind;

use super::stub::{StubAgentSession, StubPersona};
use super::{AgentAdapter, AgentSession, AgentError, EventSink, SessionContext};

pub struct CodexCliAdapter {
    persona: StubPersona,
}

impl Default for CodexCliAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexCliAdapter {
    pub fn new() -> Self {
        Self {
            persona: StubPersona {
                cli_label: "Codex CLI",
                bin_name: "codex",
            },
        }
    }
}

#[async_trait]
impl AgentAdapter for CodexCliAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::CodexCli
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        // TODO(real): 替换为 spawn `codex exec --json`，工作目录 = ctx.project_path，
        // stdout 逐行解析为 SessionEventBody 推入 events。
        let session = StubAgentSession::new(self.persona, events.clone());
        let _ = events.send(crate::models::SessionEventBody::System {
            text: format!(
                "Codex CLI 会话已就绪（桩模式 · 目录 {}）",
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
