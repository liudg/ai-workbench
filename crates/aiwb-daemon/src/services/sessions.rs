//! 会话操作：发送、停止、回答提问、排队、选项、目录和权限菜单。

use aiwb_agents::{TurnDelivery, UserTurn};
use std::path::Path;

use aiwb_agents::DiffScope;
use aiwb_core::models::{
    AgentCatalog, AgentKind, PageAnnotation, PermissionMenu, PromptAnswer, ReviewStart, ReviewTargets,
    SubscriptionUsage,
};
use aiwb_files::PreviewDocument;
use aiwb_core::task::SessionOptions;
use serde::Deserialize;

use super::{ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionId {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Send {
    session_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    images: Vec<String>,
    /// 回合进行中也立刻送进去（引导），不排队。
    #[serde(default)]
    now: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Answer {
    session_id: String,
    prompt_id: String,
    answer: PromptAnswer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Queued {
    session_id: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateQueued {
    session_id: String,
    id: String,
    text: String,
    #[serde(default)]
    images: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetOptions {
    session_id: String,
    options: SessionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diff {
    session_id: String,
    scope: String,
    #[serde(default)]
    ignore_whitespace: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadFile {
    session_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartReview {
    session_id: String,
    target: ReviewStart,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Annotation {
    session_id: String,
    note: PageAnnotation,
}

#[derive(Deserialize)]
pub(crate) struct AgentParam {
    agent: AgentKind,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sent {
    /// 回合进行中排进了队列。
    queued: bool,
}

impl Services {
    pub(crate) async fn send(&self, params: Send) -> ServiceResult<Sent> {
        let delivery = self
            .runtimes
            .send(&params.session_id, params.text, params.images, params.now)
            .await?;
        Ok(Sent {
            queued: delivery == TurnDelivery::Queued,
        })
    }

    /// 内置浏览器里的页面批注，交给 Agent。排队时不画用户气泡，等真正发出时由适配器记。
    pub(crate) async fn submit_annotation(&self, params: Annotation) -> ServiceResult<Sent> {
        let delivery = self
            .runtimes
            .submit_annotation(&params.session_id, params.note)
            .await?;
        Ok(Sent {
            queued: delivery == TurnDelivery::Queued,
        })
    }

    pub(crate) async fn interrupt(&self, params: SessionId) -> ServiceResult<()> {
        self.runtimes.interrupt(&params.session_id).await
    }

    pub(crate) async fn answer(&self, params: Answer) -> ServiceResult<()> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle
            .answer_prompt(&params.prompt_id, params.answer)
            .await
            .map_err(|e| e.to_string())
    }

    pub(crate) async fn update_queued(&self, params: UpdateQueued) -> ServiceResult<()> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        let turn = UserTurn {
            text: params.text,
            images: params.images,
            client_id: String::new(),
            annotations: Vec::new(),
        };
        handle
            .update_queued(&params.id, turn)
            .await
            .map_err(|e| e.to_string())
    }

    pub(crate) async fn remove_queued(&self, params: Queued) -> ServiceResult<()> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle.remove_queued(&params.id).await.map_err(|e| e.to_string())
    }

    pub(crate) async fn steer_queued(&self, params: Queued) -> ServiceResult<()> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle.steer_queued(&params.id).await.map_err(|e| e.to_string())
    }

    pub(crate) async fn set_options(&self, params: SetOptions) -> ServiceResult<()> {
        self.runtimes.set_options(&params.session_id, &params.options).await
    }

    /// 模型、推理强度、技能。要接上 CLI 才拿得到。
    pub(crate) async fn catalog(&self, params: SessionId) -> ServiceResult<AgentCatalog> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle.catalog().await.map_err(|e| e.to_string())
    }

    pub(crate) async fn permission_menu(&self, params: SessionId) -> ServiceResult<PermissionMenu> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle.permission_menu().await.map_err(|e| e.to_string())
    }

    /// 当前账号的订阅额度。只有声明了 `supports_subscription_usage` 的 Agent 有。
    pub(crate) async fn subscription_usage(&self, params: AgentParam) -> ServiceResult<SubscriptionUsage> {
        self.runtimes
            .adapter(params.agent)
            .subscription_usage()
            .await
            .map_err(|e| e.to_string())
    }

    /// 还没有任务时的权限菜单，不启动 CLI。
    pub(crate) fn draft_permission_menu(&self, params: AgentParam) -> PermissionMenu {
        self.runtimes.adapter(params.agent).draft_permission_menu()
    }

    /// 差异面板的范围：上一轮（Agent 提供）和 git 的几种。
    pub(crate) async fn diff_scopes(&self, params: SessionId) -> ServiceResult<Vec<DiffScope>> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle.diff_scopes().await.map_err(|e| e.to_string())
    }

    pub(crate) async fn diff(&self, params: Diff) -> ServiceResult<String> {
        let cwd = self.runtimes.workdir(&params.session_id)?;
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle
            .diff_for_scope(&cwd, &params.scope, params.ignore_whitespace)
            .await
            .map_err(|e| e.to_string())
    }

    /// 会话工作目录里的一个文件，按文本读出来。
    pub(crate) async fn read_file(&self, params: ReadFile) -> ServiceResult<PreviewDocument> {
        let cwd = self.runtimes.workdir(&params.session_id)?;
        tokio::task::spawn_blocking(move || aiwb_files::read_preview_at(Path::new(&cwd), &params.path))
            .await
            .map_err(|e| e.to_string())?
    }

    pub(crate) async fn is_git(&self, params: SessionId) -> ServiceResult<bool> {
        let cwd = self.runtimes.workdir(&params.session_id)?;
        tokio::task::spawn_blocking(move || aiwb_git::inside_work_tree(Path::new(&cwd)))
            .await
            .map_err(|e| e.to_string())?
    }

    pub(crate) async fn review_targets(&self, params: SessionId) -> ServiceResult<ReviewTargets> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        handle.review_targets().await.map_err(|e| e.to_string())
    }

    /// 代码审查。用户消息由适配器写进时间线。
    pub(crate) async fn start_review(&self, params: StartReview) -> ServiceResult<()> {
        let handle = self.runtimes.handle(&params.session_id).await?;
        if handle.read_only() {
            return Err("此会话正被其他进程占用，当前只读，不能发送。".into());
        }
        handle.start_review(params.target).await.map_err(|e| e.to_string())
    }

    pub(crate) async fn stop_session(&self, params: SessionId) -> ServiceResult<()> {
        self.runtimes.stop(&params.session_id).await;
        Ok(())
    }
}
