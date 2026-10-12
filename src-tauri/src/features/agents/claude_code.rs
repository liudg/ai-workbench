//! Claude Code 适配器（v1 桩实现）。
//!
//! 壳层约定与 Codex 相同：接入后会话 id 必须来自 Claude CLI 自己的会话存储
//! （`claude` 能 resume 的那份列表），工作台不再另造一套 id。当前桩没有官方
//! 会话，临时 id 只活在这次进程里。
//!
//! 真实集成方案（下一步）：
//! - Claude Code 是交互式 TUI：用 `portable-pty` 挂伪终端运行 `claude`，
//!   解析终端输出识别提问 / 审批界面；
//! - 或使用其 SDK / `--print` + stream-json 模式（`claude -p --output-format stream-json`），
//!   与 codex 类似地消费 JSONL 事件流，权限模式用 `--permission-prompt-tool`
//!   或 MCP 权限回调承接本应用的 needs-input 流程；
//! - `cli_release()` 用 `claude --version` 探测安装，npm 全局包装走
//!   `npm install -g @anthropic-ai/claude-code@latest`，否则走 `claude update`；
//! - 工作目录设为 `ctx.project_path`；认证交给 CLI 自身（ANTHROPIC_API_KEY
//!   或已登录的 claude.ai 会话），应用不存储任何密钥。

use std::sync::Arc;

use async_trait::async_trait;

use crate::features::agents::directory::{DirectoryEntry, SessionDirectory};
use crate::models::{AgentCapabilities, AgentKind, ChangeCapabilities};

use super::install::CliRelease;
use super::stub::{StubAgentSession, StubPersona};
use super::{AgentAdapter, AgentError, AgentSession, EventSink, SessionContext};

/// Claude 还没有官方会话目录。桩实现返回空列表，侧边栏并集里不会出现假线程。
pub struct ClaudeDirectory;

impl ClaudeDirectory {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl SessionDirectory for ClaudeDirectory {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String> {
        Ok(Vec::new())
    }

    async fn invalidate(&self) {}
}

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
            },
        }
    }
}

#[async_trait]
impl AgentAdapter for ClaudeCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            supports_slash: false,
            supports_resume: false,
            supports_questions: true,
            supports_tuning: false,
            supports_skills: false,
            supports_goals: false,
            supports_images: false,
            supports_queue: false,
            supports_fork: false,
            supports_delete: false,
            supports_rename: false,
            supports_plan: false,
            changes: ChangeCapabilities::git_only(),
            supports_review: false,
            supports_network_access: false,
            supports_writable_roots: false,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: false,
        }
    }

    fn cli_release(&self) -> Option<CliRelease> {
        Some(CliRelease {
            bins: &["claude"],
            npm_package: "@anthropic-ai/claude-code",
            self_update: &["update"],
            locate: None,
            version_args: &[],
            aliases: &[],
            note: "",
        })
    }

    async fn detect(&self) -> Result<(), AgentError> {
        let release = self.cli_release().expect("claude cli release");
        if super::install::locate_release(&release).is_some() {
            Ok(())
        } else {
            Err(AgentError::Runtime(
                "未找到 Claude Code。请先安装并确保 `claude` 在 PATH 中。".into(),
            ))
        }
    }

    async fn start_session(
        &self,
        _ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        // TODO(real): 替换为 `claude -p --output-format stream-json` 或 portable-pty，
        // 工作目录 = 项目路径，输出事件映射为 SessionEventBody 推入 events。
        let session = StubAgentSession::new(self.persona, events.clone(), self.capabilities());
        // 启动即就绪：进入等待输入的空闲态
        let _ = events.send(crate::models::SessionEventBody::StatusChanged {
            status: crate::models::SessionStatus::Completed,
        });
        Ok(Arc::new(session))
    }
}
