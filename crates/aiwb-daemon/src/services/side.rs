//! 侧边聊天：从任务现在这段对话临时分出一条来问，不进任务的时间线，关掉就丢。
//! 分叉语义参考 Codex `codex-rs/tui/src/app/side.rs`；工作台允许同时开多个独立聊天。
//! 开的时候就分叉，继承的历史不显示；关掉时停掉进程，原生会话本来就不落盘。
//! daemon 重启后接不回去，启动时清掉上次留下的。

use aiwb_core::models::{new_id, SessionStatus};
use aiwb_core::task::{SessionOptions, TaskSession};
use serde::Deserialize;

use super::{now_millis, ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SideParams {
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseSideParams {
    session_id: String,
}

const NOT_STARTED: &str = "主对话发出第一条消息后才能开侧边聊天";

impl Services {
    /// 每次从任务现在这段分出一个独立聊天，CLI 在后台接上。
    pub(crate) async fn open_side(&self, params: SideParams) -> ServiceResult<TaskSession> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let current = self
            .store
            .task_sessions(&params.task_id)
            .map_err(store_err)?
            .pop()
            .ok_or_else(|| "任务不存在".to_string())?;
        let adapter = self.runtimes.adapter(current.agent);
        if !adapter.capabilities().supports_side_chat {
            return Err(format!("{} 不支持侧边聊天", current.agent.display_name()));
        }
        // 没说过话时原生会话可能还没落盘（Codex 起线程时就有 id，第一条消息后才有 rollout），分不出来；
        // 还没交出去的前文不在原生会话里，分出来的侧边聊天会看不到它。
        // 界面上的入口按同样的条件显示（`side-chat/can-open.ts`）。
        if current.native_id.as_deref().is_none_or(str::is_empty)
            || !self.has_spoken(&current.id)?
            || self.has_pending_handoff(&current.id)?
        {
            return Err(NOT_STARTED.into());
        }
        let now = now_millis();
        let side = TaskSession {
            id: new_id(),
            task_id: params.task_id,
            agent: current.agent,
            native_id: None,
            status: SessionStatus::Completed,
            // 模型、强度、速度档和权限跟着主对话（`side_fork_config`），计划模式不带过去。
            options: SessionOptions {
                collaboration_mode: None,
                ..current.options
            },
            created_at: now,
            updated_at: now,
        };
        self.store.add_side_session(&side).map_err(store_err)?;
        self.runtimes.publish_tasks()?;
        let runtimes = self.runtimes.clone();
        let session_id = side.id.clone();
        // 打开时就分叉，问的是打开这一刻的对话。失败由 `ensure_live` 记进侧边聊天的时间线。
        tokio::spawn(async move {
            let _ = runtimes.ensure_live(&session_id).await;
        });
        Ok(side)
    }

    /// 停掉进程，删掉它、它的时间线和草稿。没开着时返回 false。
    pub(crate) async fn close_side(&self, params: CloseSideParams) -> ServiceResult<bool> {
        if !self.store.is_side_session(&params.session_id).map_err(|e| e.to_string())? {
            return Ok(false);
        }
        self.runtimes.discard_side(&params.session_id).await?;
        Ok(true)
    }

    pub(crate) async fn discard_side(&self, task_id: &str) -> ServiceResult<bool> {
        let sides = self.store.task_side_sessions(task_id).map_err(|e| e.to_string())?;
        for side in &sides {
            self.runtimes.discard_side(&side.id).await?;
        }
        Ok(!sides.is_empty())
    }

    /// 启动时调用：上次留下的侧边聊天已经接不回去了。
    pub(crate) fn drop_stale_sides(&self) -> ServiceResult<()> {
        for side in self.store.side_sessions().map_err(|e| e.to_string())? {
            self.store.remove_session(&side.id).map_err(|e| e.to_string())?;
            self.store.set_draft(&side.id, None, now_millis()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
