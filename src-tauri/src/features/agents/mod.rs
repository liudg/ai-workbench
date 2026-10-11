//! Agent 适配层：对外只暴露契约和注册表。
//!
//! 具体 CLI（Codex、Claude、其它外部 CLI）是本模块的私有实现。
//! 提问卡、审批、模型目录等共享能力走 `AgentSession` / `AgentAdapter`，
//! 会话管理和命令层不要解析某一种 CLI 的协议。

mod changes;
mod claude_code;
mod codex;
mod directory;
mod external;
mod fake;
mod install;
mod providers;
mod stub;

pub use providers::{
    submit_annotation_as_attachment, AnnotationSink, DiffScope, DiffScopeProvider,
};

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::models::{
    AgentCapabilities, AgentCatalog, AgentInstallation, AgentKind, AgentProfile, PageAnnotation,
    PermissionMenu, PromptAnswer, ReviewStart, ReviewTargets, SessionEventBody,
};

pub use directory::{
    cwd_key, group_projects, session_key, sessions_for_project, DirectoryEntry, SessionDirectory,
    SourcedEntry,
};

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

/// 用户要发出的一轮。图片是本机路径或 `data:` / `https:` 地址。
#[derive(Debug, Clone)]
pub struct UserTurn {
    pub text: String,
    pub images: Vec<String>,
    pub client_id: String,
    /// 页面批注。默认折进正文和图片附件；Codex 改写成注释附件。
    pub annotations: Vec<PageAnnotation>,
}

/// `deliver` 的结果。排队时调用方不要再写用户气泡。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnDelivery {
    Started,
    Queued,
}

/// 把页面批注折进即将发给任何 Agent 的正文，并把截图路径并进图片列表。
pub fn fold_page_annotations(
    text: &str,
    images: &mut Vec<String>,
    notes: &[PageAnnotation],
) -> String {
    if notes.is_empty() {
        return text.to_string();
    }
    let mut blocks = Vec::with_capacity(notes.len());
    for (index, note) in notes.iter().enumerate() {
        let mut lines = vec![format!("页面批注 {}", index + 1)];
        let comment = note.comment.trim();
        if !comment.is_empty() {
            lines.push(format!("评论：{comment}"));
        }
        let url = note.url.trim();
        if !url.is_empty() {
            lines.push(format!("页面：{url}"));
        }
        let selector = note.selector.trim();
        if !selector.is_empty() {
            lines.push(format!("选择器：{selector}"));
        }
        let element = note.text.trim();
        if !element.is_empty() {
            lines.push(format!("元素文本：{}", clamp_chars(element, 500)));
        }
        lines.push(format!(
            "区域：{},{} {}×{}",
            note.x, note.y, note.width, note.height
        ));
        if let Some(path) = note.screenshot.as_ref().map(|item| item.trim()).filter(|item| !item.is_empty()) {
            lines.push("附图为该区域所在页面的截图。".into());
            if !images.iter().any(|item| item == path) {
                images.push(path.to_string());
            }
        }
        blocks.push(lines.join("\n"));
    }
    let extra = blocks.join("\n\n");
    if text.trim().is_empty() {
        extra
    } else {
        format!("{text}\n\n{extra}")
    }
}

fn clamp_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn fold_images_into_text(text: &str, images: &[String]) -> String {
    if images.is_empty() {
        return text.to_string();
    }
    let names = images
        .iter()
        .map(|path| {
            std::path::Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path.as_str())
        })
        .collect::<Vec<_>>()
        .join("、");
    let line = format!("附件：{names}");
    if text.trim().is_empty() {
        line
    } else {
        format!("{text}\n\n{line}")
    }
}

/// 一个正在运行的 Agent 会话的句柄（由适配器返回）。
/// 所有方法都是非阻塞的：把输入写入 CLI 后立即返回，输出经 `EventSink` 异步推送。
#[async_trait]
pub trait AgentSession: DiffScopeProvider + AnnotationSink + Send + Sync {
    /// 发送一条用户消息（一轮新任务）。
    async fn send_message(&self, text: String) -> Result<(), AgentError>;

    /// 带图片的发送。默认把文件名拼进文本，再走 `send_message`。
    async fn deliver(&self, turn: UserTurn) -> Result<TurnDelivery, AgentError> {
        let mut images = turn.images;
        let text = fold_page_annotations(&turn.text, &mut images, &turn.annotations);
        let text = fold_images_into_text(&text, &images);
        self.send_message(text).await?;
        Ok(TurnDelivery::Started)
    }

    /// 改一条尚未发出的排队消息，保持原来的 id 和位置。
    async fn update_queued(&self, _id: &str, _turn: UserTurn) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 不支持修改排队消息".into()))
    }

    /// 从队列里去掉一条消息。没有确认框。
    async fn remove_queued(&self, _id: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 不支持删除排队消息".into()))
    }

    /// 停下当前回合，不结束会话，也不清空队列。
    async fn interrupt(&self) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 不能停止当前回合".into()))
    }

    /// 测试收尾：删掉这次打开的原生线程。正式界面不调用。
    #[cfg(test)]
    async fn discard_thread(&self) -> Result<(), AgentError> {
        Ok(())
    }

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

    /// 权限档位加上网络、额外可写目录和具名配置档。桩实现只保留档位。
    fn set_sandbox(
        &self,
        mode: &str,
        _network_access: bool,
        _writable_roots: &[String],
        _profile_id: &str,
    ) -> Result<(), AgentError> {
        self.set_access_mode(mode)
    }

    /// 当前 app-server 是否提供替我批准和权限配置档。
    async fn permission_menu(&self) -> Result<PermissionMenu, AgentError> {
        Ok(PermissionMenu::unsupported())
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

    /// 桌面端 Plan 开关。`plan` 或 `default`。
    fn set_collaboration_mode(&self, _mode: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 没有计划模式".into()))
    }

    /// `review/start`。调用方已经把菜单文案记成用户消息。
    async fn start_review(&self, _target: ReviewStart) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 不能发起代码审查".into()))
    }

    /// Code review 菜单里的分支和最近提交。
    async fn review_targets(&self) -> Result<ReviewTargets, AgentError> {
        Ok(ReviewTargets {
            branches: Vec::new(),
            commits: Vec::new(),
            error: None,
        })
    }

    /// 继续会话后，上滚再要一页更早的回合。默认没有更早的记录。
    async fn load_older_history(&self) -> Result<(Vec<SessionEventBody>, bool), AgentError> {
        Ok((Vec::new(), true))
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

    /// `thread/fork`。历史由 Codex 复制；`excludeTurns` 只影响回包体积。
    async fn fork_thread(&self, _native_id: &str) -> Result<DirectoryEntry, AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持分叉聊天",
            self.display_name()
        )))
    }

    /// `thread/name/set`。
    async fn rename_thread(&self, _native_id: &str, _name: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持重命名聊天",
            self.display_name()
        )))
    }

    /// `thread/archive` 或 `thread/unarchive`。
    async fn set_thread_archived(
        &self,
        _native_id: &str,
        _archived: bool,
    ) -> Result<(), AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持归档聊天",
            self.display_name()
        )))
    }

    /// `thread/delete`。这是 Codex 的会话删除，不是删除工作区文件。
    async fn delete_thread(&self, _native_id: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持永久删除",
            self.display_name()
        )))
    }

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
        codex::CodexDirectory::shared(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_page_annotation_into_any_agent_turn() {
        let notes = vec![PageAnnotation {
            id: "1".into(),
            url: "https://example.com/bike".into(),
            selector: "#bike".into(),
            text: "虎豹".into(),
            comment: "改成红色".into(),
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            kind: "element".into(),
            screenshot: Some("C:/shot.png".into()),
            snapshot_failed: false,
        }];
        let mut images = Vec::new();
        let text = fold_page_annotations("看这里", &mut images, &notes);
        assert!(text.starts_with("看这里\n\n页面批注 1\n"));
        assert!(text.contains("评论：改成红色"));
        assert!(text.contains("页面：https://example.com/bike"));
        assert!(text.contains("选择器：#bike"));
        assert!(text.contains("元素文本：虎豹"));
        assert!(text.contains("区域：10,20 30×40"));
        assert!(text.contains("附图为该区域所在页面的截图。"));
        assert_eq!(images, vec!["C:/shot.png".to_string()]);

        let region = PageAnnotation {
            id: "2".into(),
            url: String::new(),
            selector: String::new(),
            text: String::new(),
            comment: String::new(),
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            kind: "region".into(),
            screenshot: None,
            snapshot_failed: true,
        };
        let mut images = Vec::new();
        let text = fold_page_annotations("", &mut images, &[region]);
        assert_eq!(text, "页面批注 1\n区域：1,2 3×4");
        assert!(images.is_empty());
    }

    #[tokio::test]
    async fn claude_rename_is_unsupported_without_spawning() {
        let adapter = adapter_for(AgentKind::ClaudeCode);
        assert!(!adapter.capabilities().supports_rename);
        let err = adapter
            .rename_thread("thread", "标题")
            .await
            .expect_err("claude has no rename");
        assert!(err.to_string().contains("不支持重命名聊天"), "{err}");
    }
}
