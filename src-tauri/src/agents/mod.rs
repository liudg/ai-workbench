//! Agent 适配层：把不同 Agent CLI（Codex CLI / Claude Code）统一成同一套接口。
//!
//! Codex CLI 走本机 `codex app-server`（stdio JSON-RPC）。
//! Claude Code 仍是桩实现（见 `stub.rs`）。

pub mod claude_code;
pub mod codex_cli;
mod stub;

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::models::{AgentKind, SessionEventBody};

/// 适配器运行时错误。
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("agent 正忙，稍后再试")]
    Busy,
    #[error("存在待回答的提问，请先处理")]
    PendingPrompt,
    #[error("提问不存在或已被回答: {0}")]
    UnknownPrompt(String),
    #[error("会话已关闭")]
    Closed,
    /// 留给真实 CLI 适配器（进程 / PTY / 解析失败）使用
    #[allow(dead_code)]
    #[error("agent 运行时错误: {0}")]
    Runtime(String),
}

/// 适配器 → 会话管理器的事件通道。
/// 适配器只负责产生事件；事件的编号、持久化、转发给前端由 SessionManager 完成。
pub type EventSink = mpsc::UnboundedSender<SessionEventBody>;

/// 启动一个会话所需的上下文。
#[derive(Debug, Clone)]
pub struct SessionContext {
    /// 真实适配器用它把进程输出关联回会话；桩实现暂不需要
    #[allow(dead_code)]
    pub session_id: String,
    /// 项目根目录；真实 CLI 的工作目录
    pub project_path: String,
    /// 创建会话时的权限档位（full / ask / read-only）。缺省由适配器自定。
    pub access_mode: Option<String>,
}

/// 一个正在运行的 Agent 会话的句柄（由适配器返回）。
/// 所有方法都是非阻塞的：把输入写入 CLI 后立即返回，输出经 `EventSink` 异步推送。
#[async_trait]
pub trait AgentSession: Send + Sync {
    /// 发送一条用户消息（一轮新任务）。
    async fn send_message(&self, text: String) -> Result<(), AgentError>;

    /// 回答 Agent 发起的提问（审批 / 选择 / 自由文本）。
    async fn answer_prompt(&self, prompt_id: &str, answer: String) -> Result<(), AgentError>;

    /// 终止会话（杀掉进程 / 关闭 PTY）。调用后本句柄不可再使用。
    async fn stop(&self) -> Result<(), AgentError>;

    /// 切换本会话后续输出使用的 Agent。桩实现只改文案；真实 CLI 接入后在此重绑进程。
    fn retarget(&self, _kind: AgentKind) {}

    /// 更新后续回合的权限档位。Codex 映射到 sandbox / approval；桩实现忽略。
    fn set_access_mode(&self, _mode: &str) -> Result<(), AgentError> {
        Ok(())
    }
}

/// Agent 适配器：一种 Agent CLI 对应一个实现。
/// 负责按项目环境启动 `AgentSession`，不持有会话列表（那是 SessionManager 的职责）。
/// `kind` / `display_name` / `detect` 供 UI 与环境检查使用，接入真实 CLI 时会用到。
#[async_trait]
#[allow(dead_code)]
pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;

    fn display_name(&self) -> &'static str {
        self.kind().display_name()
    }

    /// 检测本机环境是否可用（CLI 是否安装、版本是否满足）。
    /// v1 桩实现恒为可用；真实实现应执行 `which` / `--version` 探测。
    async fn detect(&self) -> Result<(), AgentError> {
        Ok(())
    }

    /// 在指定项目目录中启动一个新会话。
    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError>;
}

/// 按类型取得适配器实例。
pub fn adapter_for(kind: AgentKind) -> Arc<dyn AgentAdapter> {
    match kind {
        AgentKind::CodexCli => Arc::new(codex_cli::CodexCliAdapter::new()),
        AgentKind::ClaudeCode => Arc::new(claude_code::ClaudeCodeAdapter::new()),
    }
}
