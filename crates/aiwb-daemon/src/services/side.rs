//! 侧边聊天：从任务现在这段对话临时分出一条来问，不进任务的时间线，关掉就丢。
//! 照 Codex `codex-rs/tui/src/app/side.rs`：一个对话同时只开一个；主回合在跑时也能开；
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

const NOT_STARTED: &str = "主对话发出第一条消息后才能开侧边聊天";

impl Services {
    /// 开着的就返回它；否则从任务现在这段分出一个，CLI 在后台接上。
    pub(crate) async fn open_side(&self, params: SideParams) -> ServiceResult<TaskSession> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        if let Some(side) = self.store.side_session(&params.task_id).map_err(store_err)? {
            return Ok(side);
        }
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
        // 还没交出去的前文不在原生会话里，分出来的侧边聊天会看不到它。
        if current.native_id.as_deref().is_none_or(str::is_empty) || self.has_pending_handoff(&current.id)? {
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
        if let Err(err) = self.store.add_side_session(&side) {
            // 同时来了两次打开（标签和排队消息），先建好的那个就是。
            return self.store.side_session(&side.task_id).map_err(store_err)?.ok_or_else(|| err.to_string());
        }
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
    pub(crate) async fn close_side(&self, params: SideParams) -> ServiceResult<bool> {
        self.discard_side(&params.task_id).await
    }

    pub(crate) async fn discard_side(&self, task_id: &str) -> ServiceResult<bool> {
        let Some(side) = self.store.side_session(task_id).map_err(|e| e.to_string())? else {
            return Ok(false);
        };
        self.runtimes.discard_side(&side.id).await?;
        Ok(true)
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
