//! Agent 适配层：把不同 Agent CLI 统一成同一套接口。
//!
//! Codex CLI 走本机 `codex app-server`（stdio JSON-RPC），并提供 `SessionDirectory`。
//! 其余种类里，Claude Code 和还没接协议的 CLI 都是桩会话；探测和更新走各自的 `cli_release`。

pub mod claude_code;
pub mod codex;
pub mod directory;
pub mod external;
pub mod install;
mod stub;

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::models::{
    AgentCapabilities, AgentCatalog, AgentInstallation, AgentKind, AgentProfile, PromptAnswer,
    SessionEventBody,
};

use directory::SessionDirectory;

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

/// 启动一个会话所需的上下文。字段对所有 Agent 通用。
/// 协议差异留在适配器里；个别开关放进 `options`。
#[derive(Debug, Clone)]
pub struct SessionContext {
    /// 工作台会话 id（`{agent}:{native_id}`）。新建时可以先为空。
    #[allow(dead_code)]
    pub session_id: String,
    /// 项目根目录；真实 CLI 的工作目录
    pub project_path: String,
    /// 创建会话时的权限档位（full / ask / read-only）。缺省由适配器自定。
    pub access_mode: Option<String>,
    /// 要恢复的原生会话 id。空表示新会话。
    pub resume_native_id: Option<String>,
    /// 适配器扩展。Codex 读取布尔 `persist`（写入官方 resume 列表）。
    pub options: serde_json::Value,
}

impl SessionContext {
    pub fn flag(&self, key: &str) -> bool {
        self.options
            .get(key)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }
}

/// 一个正在运行的 Agent 会话的句柄（由适配器返回）。
/// 所有方法都是非阻塞的：把输入写入 CLI 后立即返回，输出经 `EventSink` 异步推送。
#[async_trait]
pub trait AgentSession: Send + Sync {
    /// 发送一条用户消息（一轮新任务）。
    async fn send_message(&self, text: String) -> Result<(), AgentError>;

    /// 回答 Agent 发起的提问（审批 / 选择 / 自由文本 / 问题卡片）。
    async fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> Result<(), AgentError>;

    /// 终止会话（杀掉进程 / 关闭 PTY）。调用后本句柄不可再使用。
    async fn stop(&self) -> Result<(), AgentError>;

    /// 切换本会话后续输出使用的 Agent。桩实现只改文案；真实 CLI 接入后在此重绑进程。
    fn retarget(&self, _kind: AgentKind) {}

    /// 更新后续回合的权限档位。Codex 映射到 sandbox / approval；桩实现忽略。
    fn set_access_mode(&self, _mode: &str) -> Result<(), AgentError> {
        Ok(())
    }

    /// 当前 Agent 报告的模型和技能。桩实现返回空列表。
    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        Ok(AgentCatalog::empty())
    }

    /// 后续回合使用的模型和推理强度。空字符串表示不覆盖。
    fn set_tuning(
        &self,
        _model: Option<String>,
        _effort: Option<String>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    /// 该 Agent 的原生会话 id。没有时返回 None，由会话管理器另造 id。
    fn native_id(&self) -> Option<String> {
        None
    }

    /// 线程写锁在别的进程里。可以看历史，不能发送。
    fn read_only(&self) -> bool {
        false
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

    fn capabilities(&self) -> AgentCapabilities;

    /// 斜杠命令等不需要已打开会话就能给出的目录。模型/技能仍走 `AgentSession::catalog`。
    fn profile(&self) -> AgentProfile {
        AgentProfile {
            kind: self.kind(),
            capabilities: self.capabilities(),
            commands: Vec::new(),
        }
    }

    /// 本机 CLI 的发布信息。没有的适配器不出现在设置页和新建会话里。
    fn cli_release(&self) -> Option<install::CliRelease> {
        None
    }

    /// 检测本机环境是否可用（CLI 是否安装）。
    /// 没有声明 `cli_release` 的适配器保持可用，避免挡住仍是桩的会话。
    async fn detect(&self) -> Result<(), AgentError> {
        Ok(())
    }

    /// 探测安装版本，并对照官方来源看有没有更新。
    async fn installation(&self) -> AgentInstallation {
        match self.cli_release() {
            Some(release) => {
                install::inspect_release(self.kind(), self.display_name(), &release).await
            }
            None => AgentInstallation::absent(self.kind(), self.display_name()),
        }
    }

    /// 按适配器声明的官方渠道升级，然后重新探测。
    async fn upgrade(&self) -> Result<AgentInstallation, AgentError> {
        let Some(release) = self.cli_release() else {
            return Err(AgentError::Runtime(format!(
                "{} 没有官方更新入口",
                self.display_name()
            )));
        };
        install::upgrade_release(self.kind(), self.display_name(), &release)
            .await
            .map_err(AgentError::Runtime)
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
        AgentKind::CodexCli => Arc::new(codex::CodexCliAdapter::new()),
        AgentKind::ClaudeCode => Arc::new(claude_code::ClaudeCodeAdapter::new()),
        AgentKind::CursorAgent
        | AgentKind::CopilotCli
        | AgentKind::KimiCode
        | AgentKind::QwenCode
        | AgentKind::OpenCode
        | AgentKind::Goose
        | AgentKind::Antigravity
        | AgentKind::KiroCli => Arc::new(external::ExternalCliAdapter::new(kind)),
    }
}

/// 全部已注册种类。顺序跟着 `AgentKind::all`。没装上的也返回，设置页要列出它们。
pub async fn list_installations() -> Vec<AgentInstallation> {
    let mut handles = Vec::new();
    for kind in AgentKind::all() {
        handles.push(tokio::spawn(async move {
            adapter_for(kind).installation().await
        }));
    }
    let mut listed = Vec::new();
    for handle in handles {
        if let Ok(item) = handle.await {
            listed.push(item);
        }
    }
    listed
}

pub async fn upgrade(kind: AgentKind) -> Result<AgentInstallation, AgentError> {
    adapter_for(kind).upgrade().await
}

/// 已注册的会话目录。SessionManager 只保存 trait 对象。
pub fn session_directories() -> Vec<Arc<dyn SessionDirectory>> {
    let mut dirs: Vec<Arc<dyn SessionDirectory>> = vec![
        Arc::new(codex::CodexDirectory::new()),
        Arc::new(claude_code::ClaudeDirectory::new()),
    ];
    for kind in AgentKind::all() {
        if matches!(kind, AgentKind::CodexCli | AgentKind::ClaudeCode) {
            continue;
        }
        dirs.push(Arc::new(external::EmptyDirectory::new(kind)));
    }
    dirs
}
