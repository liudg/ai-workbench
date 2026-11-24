//! 逐轮 Git 隐藏引用检查点（Checkpoints）与对话/文件双模协同回退（Rewind）领域模型。

use serde::{Deserialize, Serialize};

/// 绑定到某一轮用户提问（`UserMessage`）的检查点记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCheckpoint {
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    /// 对应时间线里 `UserMessage` 事件的 `id`。
    pub user_event_id: String,
    /// 回退这一轮及之后所有内容时，在 `event` 表里删除 `seq >= cut_seq` 的事件。
    pub cut_seq: u64,
    /// 适配器原生回合标识（例如 Codex `turn_id` 或 Claude 该轮之前的末条消息 `uuid`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// 该轮开始前的工作树全量快照引用 `refs/aiwb/checkpoints/<session>/<id>-pre`。非 Git 目录为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_ref: Option<String>,
    /// 该轮结束后的工作树全量快照引用 `refs/aiwb/checkpoints/<session>/<id>-post`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_ref: Option<String>,
    /// 捕获 `pre_ref` 时的 `HEAD` 提交 SHA（尚无提交的空仓库为空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    /// 捕获 `pre_ref` 时所在的本地分支名（分离头指针为空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 打开回退确认弹窗前的安全预检结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindPreview {
    /// 将被撤回的用户轮次数（含所选这一轮）。
    pub turns_to_remove: usize,
    /// 是否允许选择「对话 + 文件协同回退」。
    pub can_restore_files: bool,
    /// 禁止覆盖磁盘文件时的明确原因（例如非 Git 目录、缺少快照、或同目录存在并发/更晚修改的其它会话）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_restore_disabled_reason: Option<String>,
    /// 最后一轮结束后工作区又有未归属给 Agent 的手动改动时置为 true，提醒用户确认覆盖。
    #[serde(default)]
    pub has_manual_edits_warning: bool,
}

/// 执行回退后的返回载荷，供前端将撤回的提示词与图片无损填回输入框草稿。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindResult {
    pub task_id: String,
    pub active_session_id: String,
    pub restored_text: String,
    pub restored_images: Vec<String>,
    pub files_restored: bool,
}
