//! 逐轮 Git 隐藏引用快照（Checkpoints）与对话/工作区双模协同回退（`or-01`）。

use std::collections::HashMap;
use std::path::PathBuf;

use aiwb_core::checkpoint::{RewindPreview, RewindResult, TurnCheckpoint};
use aiwb_core::models::{
    cwd_key, is_visible_user_body, is_visible_user_text, HandoffStrategy, SessionEvent,
    SessionEventBody, SessionStatus,
};
use aiwb_core::rpc::session_topic;
use aiwb_core::task::{SessionFeed, TaskWorkspace};
use serde::Deserialize;

use super::{blocking, now_millis, session_busy, ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewindPreviewParam {
    pub session_id: String,
    pub user_event_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewindSessionParam {
    pub session_id: String,
    pub user_event_id: String,
    #[serde(default)]
    pub restore_files: bool,
}

/// 判断 `events[idx]` 是否只是紧贴在某条普通用户消息（`sender: None`）之前一并投递给同一 CLI 回合的前言，
/// 而非独立发起一轮 CLI 对话的 `sender: Some(_)` 消息（如子任务/分叉首轮或独立唤醒汇报）。
fn is_preface_before_user_message(events: &[SessionEvent], idx: usize) -> bool {
    if !matches!(
        events.get(idx).map(|e| &e.body),
        Some(SessionEventBody::UserMessage {
            sender: Some(_),
            ..
        })
    ) {
        return false;
    }
    for next in &events[idx + 1..] {
        match &next.body {
            SessionEventBody::TurnAnchor { .. }
            | SessionEventBody::StatusChanged {
                status: SessionStatus::Running | SessionStatus::Starting,
            } => continue,
            SessionEventBody::UserMessage { sender: None, .. } => return true,
            _ => return false,
        }
    }
    false
}

/// 判断 `events[idx]` 是否对应实际发给原生 CLI 的一轮对话输入（含普通可见用户消息，以及非前言的独立 `sender: Some(_)` 回合）。
fn is_cli_turn_event(events: &[SessionEvent], idx: usize) -> bool {
    if is_visible_user_body(&events[idx].body) {
        return true;
    }
    match &events[idx].body {
        SessionEventBody::UserMessage {
            text,
            images,
            sender: Some(_),
            ..
        } => (is_visible_user_text(text) || !images.is_empty())
            && !is_preface_before_user_message(events, idx),
        _ => false,
    }
}

/// 统计某段事件切片（`0..limit` 且 `seq < cut_seq`）内保留的对话轮数与交接边界。
/// 返回 `(本切片总轮数, 最近一次交接之后的轮数, 最近一次交接事件)`。
fn inspect_segment_prefix(
    events: &[SessionEvent],
    limit: usize,
    cut_seq: Option<u64>,
) -> (usize, usize, Option<(&SessionEvent, HandoffStrategy, bool)>) {
    let end = limit.min(events.len());
    let within = |i: usize| cut_seq.is_none_or(|cut| events[i].seq < cut);
    let total = (0..end)
        .filter(|&i| within(i) && is_cli_turn_event(events, i))
        .count();
    let last_handoff = (0..end).rev().find_map(|i| {
        if !within(i) {
            return None;
        }
        match &events[i].body {
            SessionEventBody::Handoff {
                strategy,
                delivered,
                ..
            } => Some((i, &events[i], *strategy, *delivered)),
            _ => None,
        }
    });
    match last_handoff {
        Some((h_idx, ev, strategy, delivered)) => {
            let after = ((h_idx + 1)..end)
                .filter(|&i| within(i) && is_cli_turn_event(events, i))
                .count();
            (total, after, Some((ev, strategy, delivered)))
        }
        None => (total, total, None),
    }
}

#[derive(Debug, Clone)]
struct KeptTurnSummary {
    /// 目标分段 `cut_seq` 之前的总保留轮次数。
    prior_in_segment: usize,
    /// 当前原生线程从头累计应保留的轮次数（跨 Delta 复用段累加）。
    native_kept: usize,
    /// 若回退裁掉了最近一次已投递 `Handoff` 之后的全部轮次，保留该交接事件以便重置为未投递。
    reopen_handoff: Option<SessionEvent>,
}

/// 统计 `cut_seq` 之前保留的对话轮次数：
/// - `Full` 交接会开启全新原生线程，计数在此止步；
/// - `Delta` 交接复用同一 `(agent, effective_instance_id)` 之前分段的原生线程，需沿同实例前序分段继续向上累加。
fn count_kept_turns_across_segments(
    segments: &[aiwb_core::task::TaskSession],
    segment_events: &[Vec<SessionEvent>],
    seg_idx: usize,
    ev_idx: usize,
    cut_seq: u64,
) -> KeptTurnSummary {
    let target_events = &segment_events[seg_idx];
    let (prior_in_segment, after_handoff, last_handoff) =
        inspect_segment_prefix(target_events, ev_idx, Some(cut_seq));
    let reopen_handoff = last_handoff
        .filter(|(_, _, delivered)| *delivered && after_handoff == 0)
        .map(|(ev, _, _)| ev.clone());

    let mut native_kept = after_handoff;
    let mut should_chain = matches!(last_handoff, Some((_, HandoffStrategy::Delta, _)));
    let mut cursor = seg_idx;
    let target_agent = segments[seg_idx].agent;
    let target_inst = segments[seg_idx].effective_instance_id();

    while should_chain {
        let Some(prev_idx) = (0..cursor).rev().find(|&i| {
            segments[i].agent == target_agent
                && segments[i].effective_instance_id() == target_inst
        }) else {
            break;
        };
        let prev_events = &segment_events[prev_idx];
        let (_, prev_after, prev_handoff) =
            inspect_segment_prefix(prev_events, prev_events.len(), None);
        native_kept += prev_after;
        should_chain = matches!(prev_handoff, Some((_, HandoffStrategy::Delta, _)));
        cursor = prev_idx;
    }

    KeptTurnSummary {
        prior_in_segment,
        native_kept,
        reopen_handoff,
    }
}

/// 单分段便捷统计（供单测与局部校验使用）。
#[cfg(test)]
fn count_kept_turns_before_cut(
    events: &[SessionEvent],
    ev_idx: usize,
    cut_seq: u64,
) -> (usize, usize) {
    let (total_prior, native_kept, _) = inspect_segment_prefix(events, ev_idx, Some(cut_seq));
    (total_prior, native_kept)
}

/// 计算回退该用户消息时应一并裁掉的起始 `seq`：
/// 若适配器在 `UserMessage` 之前 1~3 条刚写下了属于本轮开头的 `TurnAnchor` / `StatusChanged(Running)` / 交接前言，
/// 一并纳入 `cut_seq`，保证截断后时间线尾部干净、不残留悬空的回合锚点。
pub(crate) fn compute_turn_cut_seq(
    events: &[SessionEvent],
    user_event_idx: usize,
) -> (u64, Option<String>) {
    let mut cut_seq = events[user_event_idx].seq;
    let mut found_turn_id = None;
    let mut i = user_event_idx;
    while i > 0 {
        let prev = &events[i - 1];
        match &prev.body {
            SessionEventBody::TurnAnchor { turn_id, .. } => {
                cut_seq = cut_seq.min(prev.seq);
                if found_turn_id.is_none() && !turn_id.trim().is_empty() {
                    found_turn_id = Some(turn_id.clone());
                }
                i -= 1;
            }
            SessionEventBody::StatusChanged {
                status: SessionStatus::Running | SessionStatus::Starting,
            } => {
                cut_seq = cut_seq.min(prev.seq);
                i -= 1;
            }
            SessionEventBody::UserMessage {
                sender: Some(_), ..
            } if is_preface_before_user_message(events, i - 1) => {
                cut_seq = cut_seq.min(prev.seq);
                i -= 1;
            }
            _ => break,
        }
    }
    if found_turn_id.is_none() {
        for next in &events[user_event_idx + 1..] {
            match &next.body {
                SessionEventBody::TurnAnchor { turn_id, .. } if !turn_id.trim().is_empty() => {
                    found_turn_id = Some(turn_id.clone());
                    break;
                }
                SessionEventBody::UserMessage { sender: None, .. } => break,
                _ => {}
            }
        }
    }
    (cut_seq, found_turn_id)
}

fn delete_grouped_checkpoint_refs_sync(
    pairs: Vec<(String, String)>,
    fallback_dir: Option<PathBuf>,
) {
    let fallback_str = fallback_dir
        .as_ref()
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned());
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    for (cwd, r) in pairs {
        if r.is_empty() {
            continue;
        }
        let effective_cwd = if !cwd.is_empty() && std::path::Path::new(&cwd).is_dir() {
            Some(cwd)
        } else {
            fallback_str.clone()
        };
        if let Some(dir) = effective_cwd {
            grouped.entry(dir).or_default().push(r);
        }
    }
    for (cwd, refs) in grouped {
        aiwb_git::delete_checkpoint_refs(std::path::Path::new(&cwd), &refs);
    }
}

pub(crate) async fn delete_grouped_checkpoint_refs_async(pairs: Vec<(String, String)>) {
    delete_grouped_checkpoint_refs_with_fallback_async(pairs, None).await;
}

pub(crate) async fn delete_grouped_checkpoint_refs_with_fallback_async(
    pairs: Vec<(String, String)>,
    fallback_dir: Option<PathBuf>,
) {
    if pairs.is_empty() {
        return;
    }
    let _ = tokio::task::spawn_blocking(move || {
        delete_grouped_checkpoint_refs_sync(pairs, fallback_dir);
    })
    .await;
}

struct SafetyAssessment {
    checkpoint: Option<TurnCheckpoint>,
    can_restore_files: bool,
    cannot_restore_files_reason: Option<String>,
    has_manual_edits_warning: bool,
}

impl Services {
    async fn evaluate_restore_safety(
        &self,
        task_id: &str,
        target_session_id: &str,
        user_event_id: &str,
    ) -> ServiceResult<SafetyAssessment> {
        let cp = self
            .store
            .checkpoint_for_user_event(target_session_id, user_event_id)
            .map_err(|e| e.to_string())?;
        let Some(cp) = cp else {
            return Ok(SafetyAssessment {
                checkpoint: None,
                can_restore_files: false,
                cannot_restore_files_reason: Some(
                    "该轮未记录 Git 文件快照（如非 Git 仓库或历史旧会话），仅可回退对话。".into(),
                ),
                has_manual_edits_warning: false,
            });
        };
        let Some(pre_ref) = cp.pre_ref.clone().filter(|r| !r.is_empty()) else {
            let cwd_check = PathBuf::from(&cp.cwd);
            let is_git = blocking(move || aiwb_git::repository_root(&cwd_check).is_ok()).await?;
            let reason = if is_git {
                "该轮未在执行前记录 Git 文件快照（如排队自动发出或回合中引导），为防止保留本轮修改，仅可回退对话。"
            } else {
                "该轮所在目录不是 Git 仓库，仅可回退对话。"
            };
            return Ok(SafetyAssessment {
                checkpoint: Some(cp),
                can_restore_files: false,
                cannot_restore_files_reason: Some(reason.into()),
                has_manual_edits_warning: false,
            });
        };

        let task = self.load_task(task_id)?;
        if matches!(
            task.workspace,
            TaskWorkspace::Worktree {
                shelved: Some(_),
                local: None,
                ..
            }
        ) {
            return Ok(SafetyAssessment {
                checkpoint: Some(cp),
                can_restore_files: false,
                cannot_restore_files_reason: Some(
                    "当前工作树已挂起清理，请先恢复工作树后再回退文件。".into(),
                ),
                has_manual_edits_warning: false,
            });
        }

        let cwd_str = self.runtimes.workdir_of_task(task_id)?;
        if cwd_key(&cwd_str) != cwd_key(&cp.cwd) {
            return Ok(SafetyAssessment {
                checkpoint: Some(cp),
                can_restore_files: false,
                cannot_restore_files_reason: Some(
                    "当前任务检出路径已变更（如已在工作树与本地目录间交接），为防止误改当前目录，仅可回退对话。"
                        .into(),
                ),
                has_manual_edits_warning: false,
            });
        }
        let cwd_path = PathBuf::from(&cwd_str);
        let cwd_git_op = cwd_path.clone();
        if let Some(op) =
            blocking(move || aiwb_git::in_progress_git_operation(&cwd_git_op)).await??
        {
            return Ok(SafetyAssessment {
                checkpoint: Some(cp),
                can_restore_files: false,
                cannot_restore_files_reason: Some(format!(
                    "当前仓库存在{op}，请先完成或中止该 Git 操作后再回退文件，目前仅可回退对话。"
                )),
                has_manual_edits_warning: false,
            });
        }
        let cwd_check = cwd_path.clone();
        let pre_ref_check = pre_ref.clone();
        let ref_exists =
            blocking(move || aiwb_git::has_checkpoint_ref(&cwd_check, &pre_ref_check)).await?;
        if !ref_exists {
            return Ok(SafetyAssessment {
                checkpoint: Some(cp),
                can_restore_files: false,
                cannot_restore_files_reason: Some(
                    "找不到对应的 Git 检查点引用，仅可回退对话。".into(),
                ),
                has_manual_edits_warning: false,
            });
        }
        let cwd_conflict = cwd_path.clone();
        let pre_ref_conflict = pre_ref.clone();
        if let Some(conflict) = blocking(move || {
            aiwb_git::checkpoint_restore_conflict(&cwd_conflict, &pre_ref_conflict)
        })
        .await??
        {
            return Ok(SafetyAssessment {
                checkpoint: Some(cp),
                can_restore_files: false,
                cannot_restore_files_reason: Some(format!("{conflict}，目前仅可回退对话。")),
                has_manual_edits_warning: false,
            });
        }

        // 检查共享同一 Git 检出根（含同仓库不同子目录）的其它未归档任务（并发运行或在此检查点之后做过操作）
        let all_tasks = self.store.list_tasks().map_err(|e| e.to_string())?;
        let all_sessions = self.store.all_sessions().map_err(|e| e.to_string())?;
        let other_candidates: Vec<(aiwb_core::task::Task, String)> = all_tasks
            .into_iter()
            .filter(|other| other.id != task_id && other.archived_at.is_none())
            .filter_map(|other| {
                let other_cwd = self.runtimes.workdir_of_task(&other.id).ok()?;
                Some((other, other_cwd))
            })
            .collect();
        let target_cwd_for_root = cwd_str.clone();
        let same_checkout_tasks = blocking(move || {
            let checkout_key = |raw: &str| -> String {
                aiwb_git::repository_root(std::path::Path::new(raw))
                    .map(|root| cwd_key(&root.to_string_lossy()))
                    .unwrap_or_else(|_| cwd_key(raw))
            };
            let target_key = checkout_key(&target_cwd_for_root);
            other_candidates
                .into_iter()
                .filter(|(_, other_cwd)| checkout_key(other_cwd) == target_key)
                .map(|(other, _)| other)
                .collect::<Vec<_>>()
        })
        .await?;

        for other in same_checkout_tasks {
            let other_busy = all_sessions
                .iter()
                .any(|s| s.task_id == other.id && session_busy(s));
            let label = if other.title.trim().is_empty() {
                "未命名会话"
            } else {
                other.title.trim()
            };
            if other_busy {
                return Ok(SafetyAssessment {
                    checkpoint: Some(cp),
                    can_restore_files: false,
                    cannot_restore_files_reason: Some(format!(
                        "同目录会话「{label}」正在运行，为防止覆盖并发修改，当前仅可回退对话。"
                    )),
                    has_manual_edits_warning: false,
                });
            }
            if other.updated_at > cp.created_at {
                return Ok(SafetyAssessment {
                    checkpoint: Some(cp),
                    can_restore_files: false,
                    cannot_restore_files_reason: Some(format!(
                        "同目录会话「{label}」在此轮之后有新活动，为防止误撤其它会话的文件改动，当前仅可回退对话。"
                    )),
                    has_manual_edits_warning: false,
                });
            }
        }

        let task_cps = self
            .store
            .task_checkpoints(task_id)
            .map_err(|e| e.to_string())?;
        let latest_post = task_cps
            .iter()
            .rev()
            .find_map(|item| item.post_ref.clone())
            .unwrap_or(pre_ref);
        let cwd_warn = cwd_path.clone();
        let manual_warning = blocking(move || {
            aiwb_git::has_working_tree_changed_since(&cwd_warn, &latest_post).unwrap_or(false)
        })
        .await?;

        Ok(SafetyAssessment {
            checkpoint: Some(cp),
            can_restore_files: true,
            cannot_restore_files_reason: None,
            has_manual_edits_warning: manual_warning,
        })
    }

    pub(crate) async fn rewind_preview(
        &self,
        params: RewindPreviewParam,
    ) -> ServiceResult<RewindPreview> {
        let caller = self
            .store
            .session(&params.session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?;
        let segments = self
            .store
            .task_sessions(&caller.task_id)
            .map_err(|e| e.to_string())?;

        let mut target_segment_idx = None;
        let mut turns_to_remove = 0usize;
        for (seg_idx, seg) in segments.iter().enumerate() {
            let stored = self.store.events_since(&seg.id, 0).map_err(|e| e.to_string())?;
            for item in &stored {
                if item.event.id == params.user_event_id {
                    target_segment_idx = Some(seg_idx);
                }
                if target_segment_idx.is_some() && is_visible_user_body(&item.event.body) {
                    turns_to_remove += 1;
                }
            }
        }

        let seg_idx = target_segment_idx.ok_or_else(|| "找不到要回退的用户消息".to_string())?;
        let target_session = &segments[seg_idx];
        let safety = self
            .evaluate_restore_safety(&caller.task_id, &target_session.id, &params.user_event_id)
            .await?;

        Ok(RewindPreview {
            turns_to_remove: turns_to_remove.max(1),
            can_restore_files: safety.can_restore_files,
            file_restore_disabled_reason: safety.cannot_restore_files_reason,
            has_manual_edits_warning: safety.has_manual_edits_warning,
        })
    }

    pub(crate) async fn rewind_session(
        &self,
        params: RewindSessionParam,
    ) -> ServiceResult<RewindResult> {
        let _worktrees = self.runtimes.worktrees.lock().await;
        let caller = self
            .store
            .session(&params.session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?;
        let task_id = caller.task_id.clone();

        // 在停会话和丢弃侧边聊天之前，先完成目标消息、工作目录与文件恢复权限的完整校验，
        // 避免回退请求被拒绝时已误删侧边对话及草稿。
        let segments = self
            .store
            .task_sessions(&task_id)
            .map_err(|e| e.to_string())?;
        let mut segment_events: Vec<Vec<SessionEvent>> = Vec::with_capacity(segments.len());
        let mut found = None;
        for (seg_idx, seg) in segments.iter().enumerate() {
            let stored = self.store.events_since(&seg.id, 0).map_err(|e| e.to_string())?;
            let events: Vec<SessionEvent> = stored.into_iter().map(|s| s.event).collect();
            if found.is_none() {
                if let Some(ev_idx) = events.iter().position(|e| e.id == params.user_event_id) {
                    found = Some((seg_idx, seg.clone(), ev_idx));
                }
            }
            segment_events.push(events);
        }
        let (seg_idx, target_session, ev_idx) =
            found.ok_or_else(|| "找不到要回退的用户消息".to_string())?;

        let (restored_text, restored_images) = match &segment_events[seg_idx][ev_idx].body {
            SessionEventBody::UserMessage { text, images, .. } => (text.clone(), images.clone()),
            _ => return Err("选中的事件不是用户消息".into()),
        };

        let (cut_seq_computed, turn_id_from_events) =
            compute_turn_cut_seq(&segment_events[seg_idx], ev_idx);
        let safety = self
            .evaluate_restore_safety(&task_id, &target_session.id, &params.user_event_id)
            .await?;

        let cwd = self.runtimes.workdir_of_task(&task_id)?;
        let restore_spec = if params.restore_files {
            if !safety.can_restore_files {
                return Err(safety
                    .cannot_restore_files_reason
                    .unwrap_or_else(|| "当前状态不允许回退工作区文件".into()));
            }
            let cp = safety
                .checkpoint
                .as_ref()
                .ok_or_else(|| "缺少 Git 检查点".to_string())?;
            let pre_ref = cp
                .pre_ref
                .clone()
                .ok_or_else(|| "缺少 Git 检查点引用".to_string())?;
            Some((pre_ref, cp.head_oid.clone(), cp.branch.clone()))
        } else {
            None
        };

        // 先停掉主对话进程（以及若有正在执行的侧边进程则仅停进程不删记录），防止 Git 恢复期间 CLI 写盘；
        // 侧边会话与草稿直到 Git 文件恢复成功后再丢弃，避免 `index.lock` 等恢复失败导致侧边对话和草稿被误删。
        self.stop_main_task_sessions(&task_id).await?;
        let task_sides = self
            .store
            .task_side_sessions(&task_id)
            .map_err(|e| e.to_string())?;
        for side in &task_sides {
            if session_busy(side) {
                self.runtimes.stop_and_mute(&side.id).await;
            }
        }

        let cut_seq = safety
            .checkpoint
            .as_ref()
            .map(|c| c.cut_seq.min(cut_seq_computed))
            .unwrap_or(cut_seq_computed);
        let target_turn_id = safety
            .checkpoint
            .as_ref()
            .and_then(|c| c.turn_id.clone())
            .or(turn_id_from_events);

        if let Some((pre_ref, head_oid, branch)) = restore_spec {
            let cwd_restore = PathBuf::from(&cwd);
            let restored = blocking(move || {
                aiwb_git::restore_checkpoint(
                    &cwd_restore,
                    &pre_ref,
                    head_oid.as_deref(),
                    branch.as_deref(),
                )
            })
            .await?;
            if let Err(err) = restored {
                let _ = self.runtimes.settle_stopped_task(&task_id);
                return Err(err);
            }
        }

        // 文件恢复已成功（或仅回退对话），正式进入不可逆的会话截断阶段，再清理侧边对话及草稿。
        self.discard_side(&task_id).await?;

        // 收集后续被丢弃的分段的检查点 Git 引用并删除分段
        let all_sessions = self.store.all_sessions().map_err(|e| e.to_string())?;
        let dropped_segment_ids: std::collections::HashSet<&str> =
            segments[seg_idx + 1..].iter().map(|s| s.id.as_str()).collect();
        let mut refs_to_delete: Vec<(String, String)> = Vec::new();
        for later_seg in &segments[seg_idx + 1..] {
            if let Ok(cps) = self.store.session_checkpoints(&later_seg.id) {
                for cp in cps {
                    if let Some(pre) = cp.pre_ref {
                        refs_to_delete.push((cp.cwd.clone(), pre));
                    }
                    if let Some(post) = cp.post_ref {
                        refs_to_delete.push((cp.cwd, post));
                    }
                }
            }
            if let Some(native) = later_seg.native_id.as_deref().filter(|s| !s.is_empty()) {
                let shared = all_sessions.iter().any(|s| {
                    !dropped_segment_ids.contains(s.id.as_str())
                        && s.agent == later_seg.agent
                        && s.effective_instance_id() == later_seg.effective_instance_id()
                        && s.native_id.as_deref() == Some(native)
                });
                if !shared {
                    if let Ok(adapter) = self.runtimes.session_adapter(later_seg) {
                        let _ = adapter.delete_thread(native).await;
                    }
                }
            }
            self.runtimes.discard(&later_seg.id).await;
            self.store
                .remove_session(&later_seg.id)
                .map_err(|e| e.to_string())?;
        }

        let summary = count_kept_turns_across_segments(
            &segments,
            &segment_events,
            seg_idx,
            ev_idx,
            cut_seq,
        );
        let kept_turns = summary.native_kept;
        let has_prior_context = summary.prior_in_segment > 0 || seg_idx > 0;

        let target_status = if has_prior_context {
            SessionStatus::Completed
        } else {
            SessionStatus::Idle
        };

        let now = now_millis();
        let dropped_cps = self
            .store
            .truncate_session_events(&target_session.id, cut_seq, target_status, now)
            .map_err(|e| e.to_string())?;
        for cp in dropped_cps {
            if let Some(pre) = cp.pre_ref {
                refs_to_delete.push((cp.cwd.clone(), pre));
            }
            if let Some(post) = cp.post_ref {
                refs_to_delete.push((cp.cwd, post));
            }
        }
        self.runtimes.clear_session_cache(&target_session.id);

        // 同步回退原生 CLI 会话（若存在其它分叉会话共享该 native_id，则禁止删除旧原生线程；
        // 若目标段所属自定义实例已删除，绝不降级调用默认实例删除/回退线程）。
        let mut need_context_handoff = false;
        if let Some(native) = target_session.native_id.as_deref().filter(|s| !s.is_empty()) {
            let shared_elsewhere = all_sessions.iter().any(|s| {
                s.id != target_session.id
                    && !dropped_segment_ids.contains(s.id.as_str())
                    && s.agent == target_session.agent
                    && s.effective_instance_id() == target_session.effective_instance_id()
                    && s.native_id.as_deref() == Some(native)
            });
            let delete_old = !shared_elsewhere;
            let rewind_outcome = match self.runtimes.session_adapter(&target_session) {
                Ok(adapter) => {
                    adapter
                        .rewind_thread(
                            native,
                            &cwd,
                            target_turn_id.as_deref(),
                            kept_turns,
                            delete_old,
                        )
                        .await
                }
                Err(err) => Err(aiwb_agents::AgentError::Runtime(err)),
            };
            match rewind_outcome {
                Ok(Some(new_native_id)) => {
                    self.store
                        .set_session_native_id(&target_session.id, &new_native_id)
                        .map_err(|e| e.to_string())?;
                    if new_native_id != native {
                        let cwd_rebind = PathBuf::from(&cwd);
                        let old_id = native.to_string();
                        let new_id = new_native_id.clone();
                        let _ = blocking(move || {
                            aiwb_git::rebind_codex_thread(&cwd_rebind, &old_id, Some(&new_id))
                        })
                        .await;
                    }
                }
                Ok(None) => {
                    self.store
                        .clear_session_native_id(&target_session.id)
                        .map_err(|e| e.to_string())?;
                    if delete_old {
                        let cwd_rebind = PathBuf::from(&cwd);
                        let old_id = native.to_string();
                        let _ = blocking(move || {
                            aiwb_git::rebind_codex_thread(&cwd_rebind, &old_id, None)
                        })
                        .await;
                    }
                    if has_prior_context {
                        need_context_handoff = true;
                    }
                }
                Err(err) => {
                    eprintln!(
                        "原生会话回退降级为前文续接（{}）：{err}",
                        target_session.id
                    );
                    self.store
                        .clear_session_native_id(&target_session.id)
                        .map_err(|e| e.to_string())?;
                    if delete_old {
                        let cwd_rebind = PathBuf::from(&cwd);
                        let old_id = native.to_string();
                        let _ = blocking(move || {
                            aiwb_git::rebind_codex_thread(&cwd_rebind, &old_id, None)
                        })
                        .await;
                    }
                    if has_prior_context {
                        need_context_handoff = true;
                    }
                }
            }
        } else if has_prior_context {
            need_context_handoff = true;
        }

        if need_context_handoff {
            if let Some(reopen) = summary.reopen_handoff {
                if let SessionEventBody::Handoff {
                    from_agent,
                    from_model,
                    to_agent,
                    to_model,
                    ..
                } = reopen.body
                {
                    self.runtimes.rewrite(
                        &target_session.id,
                        &reopen.id,
                        SessionEventBody::Handoff {
                            from_agent,
                            from_model,
                            to_agent,
                            to_model,
                            strategy: HandoffStrategy::Full,
                            delivered: false,
                            selected: 0,
                            omitted: 0,
                        },
                    )?;
                }
            } else {
                let already_pending = segment_events[seg_idx][..ev_idx].iter().any(|e| {
                    e.seq < cut_seq
                        && matches!(
                            e.body,
                            SessionEventBody::Handoff {
                                delivered: false,
                                ..
                            }
                        )
                });
                if !already_pending {
                    self.runtimes.record(
                        &target_session.id,
                        SessionEventBody::Handoff {
                            from_agent: target_session.agent,
                            from_model: target_session.options.model.clone(),
                            to_agent: target_session.agent,
                            to_model: target_session.options.model.clone(),
                            strategy: HandoffStrategy::Full,
                            delivered: false,
                            selected: 0,
                            omitted: 0,
                        },
                    )?;
                }
            }
        } else if let Some(reopen) = summary.reopen_handoff {
            // 保留了原生线程（如 Delta 复用段退回本段首轮）：把被裁掉的那次已投递交接重置为未投递，
            // 这样下一条消息才会重新补发其它 Agent 在期间产生的增量前文。
            if let SessionEventBody::Handoff {
                from_agent,
                from_model,
                to_agent,
                to_model,
                strategy,
                ..
            } = reopen.body
            {
                self.runtimes.rewrite(
                    &target_session.id,
                    &reopen.id,
                    SessionEventBody::Handoff {
                        from_agent,
                        from_model,
                        to_agent,
                        to_model,
                        strategy,
                        delivered: false,
                        selected: 0,
                        omitted: 0,
                    },
                )?;
            }
        }

        // 向前端会话订阅者推送带 reset: true 的全量时间线，立即刷新界面
        let topic = session_topic(&target_session.id);
        let remaining = self
            .store
            .events_since(&target_session.id, 0)
            .map_err(|e| e.to_string())?;
        let feed = SessionFeed {
            reset: true,
            events: remaining,
            queue: Some(Vec::new()),
        };
        let _: ServiceResult<()> = self.hub.publish_with(&topic, || -> ServiceResult<_> {
            Ok(((), serde_json::to_value(&feed).map_err(|e| e.to_string())?))
        });
        self.runtimes.publish_tasks()?;

        delete_grouped_checkpoint_refs_async(refs_to_delete).await;

        Ok(RewindResult {
            task_id,
            active_session_id: target_session.id,
            restored_text,
            restored_images,
            files_restored: params.restore_files,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_event(seq: u64, body: SessionEventBody) -> SessionEvent {
        SessionEvent {
            id: format!("ev-{seq}"),
            session_id: "s1".into(),
            seq,
            ts: seq as i64,
            body,
        }
    }

    #[test]
    fn cut_seq_absorbs_preceding_turn_anchor_and_running_status() {
        let events = vec![
            mk_event(
                1,
                SessionEventBody::UserMessage {
                    text: "轮次 1".into(),
                    images: vec![],
                    annotations: 0,
                    sender: None,
                },
            ),
            mk_event(
                2,
                SessionEventBody::AgentMessage {
                    text: "回答 1".into(),
                    stream_id: None,
                    phase: None,
                    mode: None,
                    dedupe_of: None,
                },
            ),
            mk_event(
                3,
                SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                },
            ),
            mk_event(
                4,
                SessionEventBody::TurnAnchor {
                    turn_id: "turn-2".into(),
                    mode: None,
                },
            ),
            mk_event(
                5,
                SessionEventBody::StatusChanged {
                    status: SessionStatus::Running,
                },
            ),
            mk_event(
                6,
                SessionEventBody::UserMessage {
                    text: "轮次 2".into(),
                    images: vec![],
                    annotations: 0,
                    sender: None,
                },
            ),
        ];
        let (cut_seq, turn_id) = compute_turn_cut_seq(&events, 5);
        assert_eq!(cut_seq, 4);
        assert_eq!(turn_id.as_deref(), Some("turn-2"));
    }

    #[test]
    fn kept_turns_counts_standalone_sender_turns_but_not_attached_prefaces_or_slashes() {
        use aiwb_core::models::MessageSender;

        let sender = Some(MessageSender {
            task_ids: vec!["parent-1".into()],
            fork: true,
            ..Default::default()
        });
        let events = vec![
            // Turn 1：分叉/子任务的首轮独立 CLI 提问（sender: Some(_)）
            mk_event(
                1,
                SessionEventBody::UserMessage {
                    text: "完成子任务模块重构".into(),
                    images: vec![],
                    annotations: 0,
                    sender: sender.clone(),
                },
            ),
            mk_event(
                2,
                SessionEventBody::AgentMessage {
                    text: "已完成首轮重构".into(),
                    stream_id: None,
                    phase: None,
                    mode: None,
                    dedupe_of: None,
                },
            ),
            mk_event(
                3,
                SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                },
            ),
            // 斜杠命令不算对话轮次
            mk_event(
                4,
                SessionEventBody::UserMessage {
                    text: "/goal 跑通全部单测".into(),
                    images: vec![],
                    annotations: 0,
                    sender: None,
                },
            ),
            // Turn 2：附着在用户消息前的前言（preface）+ 用户消息合并为 1 轮 CLI 提问
            mk_event(
                5,
                SessionEventBody::UserMessage {
                    text: "Subtasks have new results...".into(),
                    images: vec![],
                    annotations: 0,
                    sender,
                },
            ),
            mk_event(
                6,
                SessionEventBody::UserMessage {
                    text: "结合汇报继续修复边界".into(),
                    images: vec![],
                    annotations: 0,
                    sender: None,
                },
            ),
            mk_event(
                7,
                SessionEventBody::AgentMessage {
                    text: "已处理".into(),
                    stream_id: None,
                    phase: None,
                    mode: None,
                    dedupe_of: None,
                },
            ),
            // Turn 3：要回退的用户消息
            mk_event(
                8,
                SessionEventBody::UserMessage {
                    text: "第三轮误发的问题".into(),
                    images: vec![],
                    annotations: 0,
                    sender: None,
                },
            ),
        ];

        // 回退第 2 轮（idx = 5, seq = 6）时，cut_seq 吸收 seq=5 的前言，且保留首轮独立 sender 轮次（kept_turns = 1）
        let (cut_turn2, _) = compute_turn_cut_seq(&events, 5);
        assert_eq!(cut_turn2, 5);
        assert_eq!(count_kept_turns_before_cut(&events, 5, cut_turn2), (1, 1));

        // 回退第 3 轮（idx = 7, seq = 8）时，前言不重复计数，保留 2 轮（Turn 1 + Turn 2）
        let (cut_turn3, _) = compute_turn_cut_seq(&events, 7);
        assert_eq!(cut_turn3, 8);
        assert_eq!(count_kept_turns_before_cut(&events, 7, cut_turn3), (2, 2));
    }

    #[test]
    fn kept_turns_accumulates_across_delta_resumed_segments_and_stops_at_full_handoff() {
        use aiwb_core::models::AgentKind;
        use aiwb_core::task::{SessionOptions, TaskSession};

        let mk_seg = |id: &str, agent: AgentKind, native_id: Option<&str>| TaskSession {
            id: id.into(),
            task_id: "t1".into(),
            agent,
            instance_id: None,
            native_id: native_id.map(str::to_string),
            status: SessionStatus::Completed,
            options: SessionOptions::default(),
            created_at: 1,
            updated_at: 1,
        };
        let user = |seq: u64, text: &str| {
            mk_event(
                seq,
                SessionEventBody::UserMessage {
                    text: text.into(),
                    images: vec![],
                    annotations: 0,
                    sender: None,
                },
            )
        };
        let handoff = |seq: u64, strategy: HandoffStrategy, delivered: bool| {
            mk_event(
                seq,
                SessionEventBody::Handoff {
                    from_agent: AgentKind::CodexCli,
                    from_model: None,
                    to_agent: AgentKind::ClaudeCode,
                    to_model: None,
                    strategy,
                    delivered,
                    selected: 1,
                    omitted: 0,
                },
            )
        };

        // Seg0: Claude 完成第 1 轮 -> Seg1: 切到 Codex -> Seg2: 切回 Claude（Delta 复用）完成第 2、3 轮
        let segments = vec![
            mk_seg("s0", AgentKind::ClaudeCode, Some("claude-1")),
            mk_seg("s1", AgentKind::CodexCli, Some("codex-1")),
            mk_seg("s2", AgentKind::ClaudeCode, Some("claude-1")),
        ];
        let seg_events = vec![
            vec![user(1, "Q1")],
            vec![handoff(1, HandoffStrategy::Full, true), user(2, "QX")],
            vec![
                handoff(1, HandoffStrategy::Delta, true),
                user(2, "Q2"),
                user(3, "Q3"),
            ],
        ];

        // 回退第 3 轮（Seg2 idx=2, seq=3）：原生 Claude 记录里应保留 Q1 + Q2 = 2 轮！
        let s_q3 = count_kept_turns_across_segments(&segments, &seg_events, 2, 2, 3);
        assert_eq!(s_q3.prior_in_segment, 1);
        assert_eq!(s_q3.native_kept, 2);
        assert!(s_q3.reopen_handoff.is_none());

        // 回退第 2 轮（Seg2 idx=1, seq=2）：原生 Claude 记录保留 Seg0 的 Q1 = 1 轮，同时需重开 Delta Handoff！
        let s_q2 = count_kept_turns_across_segments(&segments, &seg_events, 2, 1, 2);
        assert_eq!(s_q2.prior_in_segment, 0);
        assert_eq!(s_q2.native_kept, 1);
        assert_eq!(s_q2.reopen_handoff.as_ref().map(|e| e.id.as_str()), Some("ev-1"));

        // 若 Seg2 中间经历过 Full Handoff（全新原生线程），计数在 Full Handoff 处止步，不累加 Seg0！
        let seg_events_full = vec![
            vec![user(1, "Q1")],
            vec![handoff(1, HandoffStrategy::Full, true), user(2, "QX")],
            vec![
                handoff(1, HandoffStrategy::Delta, true),
                user(2, "Q2"),
                handoff(3, HandoffStrategy::Full, true),
                user(4, "Q3"),
                user(5, "Q4"),
            ],
        ];
        let s_q4 = count_kept_turns_across_segments(&segments, &seg_events_full, 2, 4, 5);
        assert_eq!(s_q4.native_kept, 1);
    }
}
