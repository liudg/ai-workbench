//! 一个正在运行的 Agent 会话。方法对 Codex 和 Claude Code 同一套；
//! 协议差异留在各自的适配器里，事件一律写成归一化的 [`crate::models::SessionEventBody`]。

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::models::{
    AgentCatalog, PageAnnotation, PermissionMenu, PromptAnswer, ReviewStart, ReviewTargets,
    SessionEventBody,
};

use super::error::AgentError;
use super::surface::{AnnotationSink, DiffScopeProvider};
use super::turn::{fold_images_into_text, fold_page_annotations, TurnDelivery, UserTurn};

/// 适配器 → 会话管理器的事件通道。
/// 适配器只负责产生事件；事件的编号、持久化、转发给前端由 SessionManager 完成。
pub type EventSink = mpsc::UnboundedSender<SessionEventBody>;

/// 一个正在运行的 Agent 会话的句柄。
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

    /// 终止会话（关掉进程）。调用后本句柄不可再使用。
    async fn stop(&self) -> Result<(), AgentError>;

    /// 更新后续回合的权限档位。各适配器映射到自己的权限模式。
    fn set_access_mode(&self, _mode: &str) -> Result<(), AgentError> {
        Ok(())
    }

    /// 权限档位，以及适配器声明支持的网络、额外可写目录和具名配置档。
    fn set_sandbox(
        &self,
        mode: &str,
        _network_access: bool,
        _writable_roots: &[String],
        _profile_id: &str,
    ) -> Result<(), AgentError> {
        self.set_access_mode(mode)
    }

    /// 当前会话的权限菜单。没有沙箱档或具名配置档时返回 [`PermissionMenu::unsupported`]。
    async fn permission_menu(&self) -> Result<PermissionMenu, AgentError> {
        Ok(PermissionMenu::unsupported())
    }

    /// 当前 Agent 报告的模型和技能。
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

    /// 计划模式。`plan` 或 `default`。
    fn set_collaboration_mode(&self, _mode: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 没有计划模式".into()))
    }

    /// 设置目标。目标不能为空。
    async fn set_goal(&self, _objective: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 没有目标".into()))
    }

    /// 清除目标。
    async fn clear_goal(&self) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 没有目标".into()))
    }

    /// 把当前目标再推一次。没有目标时直接成功，不编造。
    async fn publish_goal(&self) -> Result<(), AgentError> {
        Ok(())
    }

    /// 发起代码审查。调用方已经把菜单文案记成用户消息。
    async fn start_review(&self, _target: ReviewStart) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 不能发起代码审查".into()))
    }

    /// 代码审查菜单里的分支和最近提交。
    async fn review_targets(&self) -> Result<ReviewTargets, AgentError> {
        Ok(ReviewTargets {
            branches: Vec::new(),
            commits: Vec::new(),
            error: None,
            current_branch: None,
            labels: Default::default(),
        })
    }

    /// 继续会话后，上滚再要一页更早的回合。默认没有更早的记录。
    async fn load_older_history(&self) -> Result<(Vec<SessionEventBody>, bool), AgentError> {
        Ok((Vec::new(), true))
    }
}

/// 默认批注通道：折进正文，截图作为附件，再走 `deliver`。
pub async fn submit_annotation_as_attachment(
    session: &dyn AgentSession,
    note: PageAnnotation,
) -> Result<TurnDelivery, AgentError> {
    session
        .deliver(UserTurn {
            text: String::new(),
            images: Vec::new(),
            client_id: String::new(),
            annotations: vec![note],
        })
        .await
}

/// 会话句柄的类型擦除，注册表只存这一层。
pub type SessionHandle = Arc<dyn AgentSession>;
