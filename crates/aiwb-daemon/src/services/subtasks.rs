//! 嵌套任务：会话里的 Agent 经工作台 MCP 开出挂在自己任务下的子任务，跑完把结果交回来。
//! 见 `docs/agent-orchestration.md`。工具层在 `crate::mcp::subtasks`，这里是规则和数据。

mod reports;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use aiwb_core::attention::{AskKind, AttentionState};
use aiwb_core::models::{now_millis, AgentKind, MessageSender, SessionEventBody, SessionStatus};
use aiwb_core::task::{
    Initiation, OfferResolution, SessionAccess, SessionOptions, SubtaskSpec, Task, TaskSession,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::tasks::CreateTask;
use super::{ServiceResult, Services};
use super::Caller;
use crate::runtime::{task_branch, Outgoing, StatusNote};

use reports::{Batch, Driver, Note, Reports};

/// 工作台统一的权限档位，从窄到宽。
const ACCESS_ORDER: [&str; 4] = ["read-only", "ask", "approve-for-me", "full"];
/// 回报里每个子任务的回答留多少字。
const ANSWER_CHARS: usize = 400;
/// 自己提议的卡片一个回合最多几张。
const MAX_PROPOSALS_PER_TURN: usize = 3;
/// 自己提议的卡片多久没点就过期。
const PROPOSAL_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// 父会话的草稿这么久内改过，算用户正在打字，回报晚点再送。
const TYPING_MS: i64 = 30_000;

/// Agent 要开的一个子任务，还没按父任务的规则补全。
pub(crate) struct SubtaskRequest {
    pub(crate) agent: Option<AgentKind>,
    pub(crate) title: String,
    pub(crate) prompt: String,
    pub(crate) worktree: bool,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) access: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtaskRow {
    task_id: String,
    title: String,
    agent: AgentKind,
    state: AttentionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask: Option<AskKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
}

/// 嵌套任务在内存里的状态。
#[derive(Default)]
pub(crate) struct SubtaskState {
    reports: Mutex<Reports>,
    /// 正在开子任务的卡片。两个窗口同时点也只开一次。
    resolving: Mutex<HashSet<String>>,
    /// 正在送回报的父任务 → 期间又有新结果要看。
    flushing: Mutex<HashMap<String, bool>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveOffer {
    session_id: String,
    offer_id: String,
    accept: bool,
}

impl Services {
    /// 接上会话状态变化，送子任务回报。daemon 启动时调用一次。
    pub fn start_subtask_reports(self: &Arc<Self>) {
        let Some(mut notes) = self.runtimes.take_status_notes() else {
            return;
        };
        let services = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(note) = notes.recv().await {
                // 结果按顺序记；送回报各个父任务分开跑，一个父会话起得慢不耽误别的。
                for target in services.note_status(&note) {
                    let services = Arc::clone(&services);
                    tokio::spawn(async move { services.flush_reports(&target).await });
                }
            }
        });
    }

    /// 记下子任务回合的结果，返回有东西要送的任务：它自己（中间层既是子任务也是父任务，空下来时要收
    /// 自己子任务的回报）和往上的每一层（它们可能正等着下面停下）。
    fn note_status(&self, note: &StatusNote) -> Vec<String> {
        let Some(task) = self.store.task(&note.task_id).ok().flatten() else {
            return Vec::new();
        };
        if task.archived_at.is_some() {
            return Vec::new();
        }
        if let Some(parent) = &task.parent_task_id {
            self.reports().turn_ended(parent, &task.id, note.status);
        }
        let mut targets = vec![task.id];
        let mut above = task.parent_task_id;
        while let Some(id) = above {
            above = self.store.task(&id).ok().flatten().and_then(|task| task.parent_task_id);
            targets.push(id);
        }
        let reports = self.reports();
        targets.retain(|id| reports.pending(id));
        targets
    }

    fn reports(&self) -> std::sync::MutexGuard<'_, Reports> {
        self.subtasks.reports.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 能用的 Agent 和它们的目录，以及调用方自己现在的设置。
    pub(crate) fn subtask_capabilities(&self, caller: &Caller) -> ServiceResult<Value> {
        let options = &caller.session.options;
        let agents: Vec<Value> = AgentKind::all()
            .into_iter()
            .filter(|kind| self.runtimes.adapter(*kind).session_linked())
            .map(|kind| {
                let adapter = self.runtimes.adapter(kind);
                let models: Vec<Value> = self
                    .stored_catalog(kind)
                    .ok()
                    .flatten()
                    .map(|catalog| {
                        catalog
                            .models
                            .iter()
                            .filter(|model| model.show_in_picker)
                            .map(|model| {
                                json!({
                                    "id": model.id,
                                    "label": model.label,
                                    "isDefault": model.is_default,
                                    "efforts": model.efforts.iter().map(|effort| effort.id.clone()).collect::<Vec<_>>(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                json!({
                    "agent": kind,
                    "name": adapter.display_name(),
                    "models": models,
                    "access": supported_access(self, kind),
                    "planMode": adapter.capabilities().supports_plan,
                })
            })
            .collect();
        Ok(json!({
            "you": {
                "agent": caller.session.agent,
                "model": options.model,
                "effort": options.effort,
                "access": self.access_mode_of(&caller.session),
                "planMode": options.collaboration_mode.as_deref() == Some("plan"),
            },
            "agents": agents,
        }))
    }

    /// 开子任务。`user_asked` 直接开；另外两种先在调用方的时间线里出卡片。
    pub(crate) async fn create_subtasks(
        &self,
        caller: &Caller,
        initiation: Initiation,
        requests: Vec<SubtaskRequest>,
    ) -> ServiceResult<Value> {
        if requests.is_empty() {
            return Err("invalid: give at least one subtask".into());
        }
        // 独立聊天没有仓库：子任务和它共用同一个文件夹。
        if caller.task.project_id.is_none() && requests.iter().any(|request| request.worktree) {
            return Err("invalid: this chat has no git repository, so subtasks cannot get a worktree; they work in the chat's own folder".into());
        }
        let specs = requests
            .into_iter()
            .map(|request| self.subtask_spec(&caller.session, request))
            .collect::<ServiceResult<Vec<_>>>()?;
        match initiation {
            // 开到一半失败也算一个结果，按 clientRequestId 重试时直接给它，不再重开。
            Initiation::UserAsked => {
                let (opened, error) = self.open_subtasks(&caller.task, &specs).await;
                if !opened.is_empty() {
                    self.record_opened(&caller.session.id, specs, &opened)?;
                }
                match (opened, error) {
                    (opened, None) => Ok(json!({ "status": "opened", "subtasks": opened })),
                    (opened, Some(err)) if opened.is_empty() => Err(err),
                    (opened, Some(err)) => Ok(json!({ "status": "partly_opened", "subtasks": opened, "error": err })),
                }
            }
            Initiation::Offer | Initiation::OwnInitiative => {
                if initiation == Initiation::OwnInitiative {
                    self.check_proposal(&caller.session, &specs)?;
                }
                let offer_id = aiwb_core::models::new_id();
                self.runtimes.record(
                    &caller.session.id,
                    SessionEventBody::SubtaskOffer {
                        offer_id: offer_id.clone(),
                        initiation,
                        subtasks: specs,
                        expires_at: (initiation == Initiation::OwnInitiative).then(|| now_millis() + PROPOSAL_TTL_MS),
                        resolution: None,
                    },
                )?;
                let next = if initiation == Initiation::Offer {
                    "A card now asks the user. End your turn now and wait; you will get a message with the user's choice."
                } else {
                    "A card was shown to the user. Do not wait for it; continue your own work."
                };
                Ok(json!({ "status": "waiting_for_user", "offerId": offer_id, "next": next }))
            }
        }
    }

    /// 直接开出的子任务也在父时间线里留一条，和选过「另开」的卡片一样画成子任务行。
    fn record_opened(&self, session_id: &str, specs: Vec<SubtaskSpec>, opened: &[Value]) -> ServiceResult<()> {
        let task_ids = opened
            .iter()
            .filter_map(|item| item["taskId"].as_str().map(str::to_string))
            .collect();
        self.runtimes.record(
            session_id,
            SessionEventBody::SubtaskOffer {
                offer_id: aiwb_core::models::new_id(),
                initiation: Initiation::UserAsked,
                subtasks: specs,
                expires_at: None,
                resolution: Some(OfferResolution::Accepted { task_ids }),
            },
        )?;
        Ok(())
    }

    /// 按父任务补全：Agent 缺省和父任务一样，权限缺省继承且不能更宽，父任务在计划模式时子任务也是。
    fn subtask_spec(&self, parent: &TaskSession, request: SubtaskRequest) -> ServiceResult<SubtaskSpec> {
        let agent = request.agent.unwrap_or(parent.agent);
        let adapter = self.runtimes.adapter(agent);
        if !adapter.session_linked() {
            return Err(format!("unsupported_agent: {} cannot chat in the workbench yet", agent.display_name()));
        }
        let title = request.title.trim().to_string();
        let prompt = request.prompt.trim().to_string();
        if title.is_empty() || prompt.is_empty() {
            return Err("invalid: every subtask needs a title and a prompt".into());
        }
        reject_command(&prompt)?;
        let plan = parent.options.collaboration_mode.as_deref() == Some("plan");
        if plan && !adapter.capabilities().supports_plan {
            return Err(format!(
                "plan_mode: you are in plan mode, so subtasks must be too, and {} has no plan mode",
                agent.display_name()
            ));
        }
        Ok(SubtaskSpec {
            agent,
            title,
            prompt,
            worktree: request.worktree,
            options: SessionOptions {
                model: nonempty(request.model),
                effort: nonempty(request.effort),
                access: Some(self.subtask_access(parent, agent, request.access.as_deref())?),
                collaboration_mode: plan.then(|| "plan".to_string()),
                ..Default::default()
            },
        })
    }

    /// 会话现在的权限档位。没选过时是适配器的缺省。
    fn access_mode_of(&self, session: &TaskSession) -> String {
        session
            .options
            .access
            .as_ref()
            .map(|access| access.mode.clone())
            .filter(|mode| !mode.is_empty())
            .or_else(|| self.runtimes.adapter(session.agent).profile().default_access)
            .unwrap_or_else(|| "full".into())
    }

    /// 照 t3code `resolveRuntimeMode`：指定的档位比父任务宽就拒绝（`runtime_mode_escalation_denied`）。
    /// 没指定时继承父任务的；子任务的 Agent 没有这一档时取它有的、不比父任务宽的最宽一档。
    fn subtask_access(&self, parent: &TaskSession, agent: AgentKind, requested: Option<&str>) -> ServiceResult<SessionAccess> {
        let parent_mode = self.access_mode_of(parent);
        // 具名配置档排不出宽窄，按询问批准算。
        let ceiling = rank(&parent_mode).unwrap_or(1);
        let supported = supported_access(self, agent);
        let mode = match requested.map(str::trim).filter(|mode| !mode.is_empty()) {
            Some(mode) => {
                let wanted = rank(mode).ok_or_else(|| format!("invalid: unknown permission level {mode}"))?;
                if wanted > ceiling {
                    return Err(format!(
                        "permission_escalation: a subtask cannot have wider permissions than yours (you have {parent_mode}, asked for {mode})"
                    ));
                }
                if !supported.iter().any(|item| item == mode) {
                    return Err(format!("unsupported_access: {} has no {mode} level", agent.display_name()));
                }
                mode.to_string()
            }
            None => supported
                .iter()
                .filter(|item| rank(item).is_some_and(|value| value <= ceiling))
                .max_by_key(|item| rank(item))
                .cloned()
                .ok_or_else(|| {
                    format!("permission_escalation: {} has no permission level within yours", agent.display_name())
                })?,
        };
        // 同一种 Agent 原样继承网络和额外目录。
        if agent == parent.agent && mode == parent_mode {
            if let Some(access) = parent.options.access.clone() {
                return Ok(access);
            }
        }
        Ok(SessionAccess {
            mode,
            ..Default::default()
        })
    }

    /// 卡片可能放了好几天：开之前按父任务现在的权限和计划模式再看一遍。
    fn still_within(&self, parent: &TaskSession, spec: &SubtaskSpec) -> ServiceResult<()> {
        let ceiling = rank(&self.access_mode_of(parent)).unwrap_or(1);
        let mode = spec.options.access.as_ref().map_or("full", |access| access.mode.as_str());
        let plan = parent.options.collaboration_mode.as_deref() == Some("plan");
        if rank(mode).is_none_or(|wanted| wanted > ceiling)
            || (plan && spec.options.collaboration_mode.as_deref() != Some("plan"))
        {
            return Err("父任务的权限已经收窄，这张卡片不能再开".into());
        }
        Ok(())
    }

    /// 自己提议的卡片：一个回合最多几张，同一件事不重复提。
    fn check_proposal(&self, session: &TaskSession, specs: &[SubtaskSpec]) -> ServiceResult<()> {
        let events = self.store.events_since(&session.id, 0).map_err(|e| e.to_string())?;
        let turn_start = events
            .iter()
            .rposition(|stored| matches!(stored.event.body, SessionEventBody::UserMessage { .. }))
            .unwrap_or(0);
        let titles: Vec<&str> = specs.iter().map(|spec| spec.title.as_str()).collect();
        let mut this_turn = 0;
        for (index, stored) in events.iter().enumerate() {
            let SessionEventBody::SubtaskOffer {
                initiation,
                subtasks,
                resolution,
                ..
            } = &stored.event.body
            else {
                continue;
            };
            if *initiation == Initiation::OwnInitiative && index >= turn_start {
                this_turn += 1;
            }
            let same: Vec<&str> = subtasks.iter().map(|spec| spec.title.as_str()).collect();
            if same == titles {
                let state = if resolution.is_none() { "still waiting for the user" } else { "the user already answered it" };
                return Err(format!("duplicate: this was already proposed and is {state}"));
            }
        }
        if this_turn >= MAX_PROPOSALS_PER_TURN {
            return Err(format!("too_many_proposals: at most {MAX_PROPOSALS_PER_TURN} proposals per turn"));
        }
        Ok(())
    }

    /// 开出子任务，第一条消息由 `create_task` 在后台发出。中途失败时返回已经开出的和错误。
    /// 开的过程中父任务的回报先压着，一批里先跑完的不会单独回报。
    /// 调用中途被丢掉（客户端断开）时靠守卫放开。
    async fn open_subtasks(&self, parent: &Task, specs: &[SubtaskSpec]) -> (Vec<Value>, Option<String>) {
        let _held = Held::new(self, &parent.id);
        self.open_each(parent, specs).await
    }

    async fn open_each(&self, parent: &Task, specs: &[SubtaskSpec]) -> (Vec<Value>, Option<String>) {
        let mut opened = Vec::new();
        for spec in specs {
            let entry = match self.create_task(CreateTask::subtask(parent, spec)).await {
                Ok(entry) => entry,
                Err(err) => return (opened, Some(err)),
            };
            self.reports().opened(&parent.id, &entry.task.id);
            opened.push(json!({
                "taskId": entry.task.id,
                "title": entry.task.title,
                "agent": spec.agent,
                "branch": task_branch(&entry.task),
            }));
        }
        (opened, None)
    }

    /// 用户在卡片上选了。
    pub(crate) async fn resolve_offer(&self, params: ResolveOffer) -> ServiceResult<()> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let session = self
            .store
            .session(&params.session_id)
            .map_err(store_err)?
            .ok_or_else(|| "会话不存在".to_string())?;
        let task = self
            .store
            .task(&session.task_id)
            .map_err(store_err)?
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.archived_at.is_some() {
            return Err("任务已归档".into());
        }
        let _resolving = Resolving::claim(&self.subtasks.resolving, &params.offer_id)?;
        let stored = self
            .store
            .events_since(&session.id, 0)
            .map_err(store_err)?
            .into_iter()
            .find(|stored| {
                matches!(&stored.event.body, SessionEventBody::SubtaskOffer { offer_id, .. } if *offer_id == params.offer_id)
            })
            .ok_or_else(|| "没有这张卡片".to_string())?;
        let SessionEventBody::SubtaskOffer {
            offer_id,
            initiation,
            subtasks,
            expires_at,
            resolution: None,
        } = stored.event.body
        else {
            return Err("这张卡片已经处理过了".into());
        };
        if expires_at.is_some_and(|at| now_millis() > at) {
            return Err("这个提议已过期".into());
        }
        let titles = subtasks.iter().map(|spec| spec.title.as_str()).collect::<Vec<_>>().join(", ");
        let mut failed = None;
        let (resolution, note) = if params.accept {
            let current = self
                .store
                .task_sessions(&task.id)
                .map_err(store_err)?
                .pop()
                .ok_or_else(|| "任务没有会话".to_string())?;
            for spec in &subtasks {
                self.still_within(&current, spec)?;
            }
            let (opened, error) = self.open_subtasks(&task, &subtasks).await;
            if opened.is_empty() {
                return Err(error.unwrap_or_else(|| "没有开出子任务".into()));
            }
            failed = error.map(|err| partly_opened(err, &opened));
            let ids: Vec<String> = opened
                .iter()
                .filter_map(|item| item["taskId"].as_str().map(str::to_string))
                .collect();
            let note = Note {
                text: format!(
                    "The user chose to split this off. Opened subtasks: {}. Their results will come back to you; do not wait for them.",
                    opened_list(&opened)
                ),
                task_ids: ids.clone(),
            };
            (OfferResolution::Accepted { task_ids: ids }, Some(note))
        } else {
            // 自己提议的被拒，Agent 本来就没等，不用告诉它。
            let note = (initiation == Initiation::Offer).then(|| Note {
                text: format!("The user chose to do this here instead of in a subtask. Do it yourself now: {titles}."),
                task_ids: Vec::new(),
            });
            (OfferResolution::Declined, note)
        };
        self.runtimes.rewrite(
            &session.id,
            &stored.event.id,
            SessionEventBody::SubtaskOffer {
                offer_id,
                initiation,
                subtasks,
                expires_at,
                resolution: Some(resolution),
            },
        )?;
        if let Some(note) = note {
            self.reports().note(&task.id, note);
            self.flush_reports(&task.id).await;
        }
        failed.map_or(Ok(()), Err)
    }

    pub(crate) fn list_subtasks(&self, caller: &Caller) -> ServiceResult<Vec<SubtaskRow>> {
        Ok(self
            .store
            .task_entries()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|entry| {
                entry.task.parent_task_id.as_deref() == Some(caller.task.id.as_str()) && entry.task.archived_at.is_none()
            })
            .filter_map(|entry| {
                let current = entry.sessions.last()?;
                Some(SubtaskRow {
                    task_id: entry.task.id.clone(),
                    branch: task_branch(&entry.task),
                    title: entry.task.title,
                    agent: current.agent,
                    state: entry.attention.state,
                    ask: entry.attention.ask,
                    last_message: entry.attention.preview,
                })
            })
            .collect())
    }

    /// 只认调用方任务下的子任务，和它现在用的会话。
    fn own_subtask(&self, caller: &Caller, task_id: &str) -> ServiceResult<(Task, TaskSession)> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let task = self
            .store
            .task(task_id)
            .map_err(store_err)?
            .filter(|task| {
                task.parent_task_id.as_deref() == Some(caller.task.id.as_str()) && task.archived_at.is_none()
            })
            .ok_or_else(|| format!("not_found: you have no subtask {task_id}, or it was archived"))?;
        let session = self
            .store
            .task_sessions(task_id)
            .map_err(store_err)?
            .pop()
            .ok_or_else(|| "not_found: the subtask has no session".to_string())?;
        Ok((task, session))
    }

    /// 分页读子任务的时间线，从新往旧翻。缺省只有消息、回答和计划。
    pub(crate) fn read_subtask(
        &self,
        caller: &Caller,
        task_id: &str,
        before: Option<u64>,
        limit: usize,
        all: bool,
    ) -> ServiceResult<Value> {
        let (task, session) = self.own_subtask(caller, task_id)?;
        let items: Vec<Value> = self
            .store
            .events_since(&session.id, 0)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|stored| before.is_none_or(|before| stored.event.seq < before))
            .filter_map(|stored| {
                let (kind, text) = timeline_item(&stored.event.body, all)?;
                Some(json!({ "seq": stored.event.seq, "kind": kind, "text": text }))
            })
            .collect();
        let limit = limit.clamp(1, 100);
        let start = items.len().saturating_sub(limit);
        let next_before = (start > 0).then(|| items[start]["seq"].clone());
        let state = self
            .store
            .attention(&session.id)
            .map_err(|e| e.to_string())?
            .map(|attention| attention.state);
        Ok(json!({
            "taskId": task.id,
            "title": task.title,
            "state": state,
            "branch": task_branch(&task),
            "items": items[start..],
            "nextBefore": next_before,
        }))
    }

    /// 给子任务追加消息。子任务在等用户批准或回答时拒绝，不替用户答（照 herdr `agent_blocked`）。
    pub(crate) async fn send_subtask(&self, caller: &Caller, task_id: &str, text: String, steer: bool) -> ServiceResult<Value> {
        reject_command(&text)?;
        let (task, session) = self.own_subtask(caller, task_id)?;
        let waiting = self
            .store
            .attention(&session.id)
            .map_err(|e| e.to_string())?
            .is_some_and(|attention| attention.state == AttentionState::NeedsInput);
        if waiting {
            return Err("blocked: the subtask is waiting for the user's approval or answer. Tell the user to handle it; never answer on their behalf.".into());
        }
        self.reports().drive(&task.id, Driver::Parent);
        let message = Outgoing {
            sender: Some(MessageSender {
                task_ids: vec![caller.task.id.clone()],
            }),
            ..Outgoing::user(text, Vec::new(), steer)
        };
        let delivery = self.runtimes.send_message(&session.id, message).await?;
        Ok(json!({ "queued": delivery == aiwb_agents::TurnDelivery::Queued }))
    }

    pub(crate) async fn interrupt_subtask(&self, caller: &Caller, task_id: &str) -> ServiceResult<()> {
        let (_, session) = self.own_subtask(caller, task_id)?;
        self.runtimes.interrupt(&session.id).await
    }

    /// 用户在界面上发消息。子任务里用户自己开的回合不叫醒父会话；
    /// 父会话里发消息时把没送出的回报一起带上。
    pub(crate) async fn send_from_user(&self, session_id: &str, mut message: Outgoing) -> ServiceResult<aiwb_agents::TurnDelivery> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let session = self.store.session(session_id).map_err(store_err)?;
        let main = match &session {
            Some(session) if !self.store.is_side_session(session_id).map_err(store_err)? => {
                self.store.task(&session.task_id).map_err(store_err)?
            }
            _ => None,
        };
        let command = message.text.trim_start().starts_with('/');
        let mut taken = None;
        if let (Some(session), Some(task)) = (&session, &main) {
            let idle = !matches!(session.status, SessionStatus::Running | SessionStatus::NeedsInput);
            // 斜杠命令照原样发，回报留到下一条普通消息。
            if idle && !message.now && !command {
                taken = self.reports().take_for_user(&task.id);
                if let Some(batch) = &taken {
                    message.preface = Some((self.report_text(batch), sender_of(batch)));
                }
            }
        }
        let sent = self.runtimes.send_message(session_id, message).await;
        match (&sent, &main) {
            (Err(_), Some(task)) => {
                if let Some(batch) = taken {
                    self.reports().restore(&task.id, batch);
                }
            }
            // 用户说了话（不算命令）：在父任务里重新开始数叫醒次数，在子任务里这一回合算用户的。
            (Ok(_), Some(task)) if !command => {
                self.reports().user_spoke(&task.id);
                if task.parent_task_id.is_some() {
                    self.reports().drive(&task.id, Driver::User);
                }
            }
            _ => {}
        }
        sent
    }

    /// 父会话空闲、用户没在打字时，把该送的回报送出去。
    /// 用户在打字时不打断，留着等用户发消息时一起带上（[`Self::send_from_user`]），或者下一次状态变化再看。
    async fn flush_reports(&self, parent_id: &str) {
        // 同一个父任务同时只有一个在送。别处想送时记一笔，正在送的这个做完再看一遍。
        let Some(flushing) = Flushing::claim(&self.subtasks.flushing, parent_id) else {
            return;
        };
        loop {
            self.flush_once(parent_id).await;
            if !flushing.again() {
                break;
            }
        }
    }

    async fn flush_once(&self, parent_id: &str) {
        // 归档的父任务不叫醒，结果留着等它回来。
        if !self.store.task(parent_id).ok().flatten().is_some_and(|task| task.archived_at.is_none()) {
            return;
        }
        let Ok(Some(session)) = self.store.task_sessions(parent_id).map(|mut sessions| sessions.pop()) else {
            return;
        };
        if matches!(session.status, SessionStatus::Running | SessionStatus::NeedsInput) {
            return;
        }
        if self.typing(&session.id) {
            return;
        }
        let descendants_working = self.descendants_working(parent_id);
        let Some(batch) = self.reports().take_for_wake(parent_id, descendants_working) else {
            return;
        };
        // 立刻送：父会话这时空着就开一个回合；刚好有回合开起来时引导进去，不排进队列变成用户的消息。
        let message = Outgoing {
            sender: Some(sender_of(&batch)),
            ..Outgoing::user(self.report_text(&batch), Vec::new(), true)
        };
        if let Err(err) = self.runtimes.send_message(&session.id, message).await {
            eprintln!("给任务 {parent_id} 送子任务回报失败：{err}");
            self.reports().restore(parent_id, batch);
        }
    }

    fn typing(&self, session_id: &str) -> bool {
        let Ok(Some((draft, at))) = self.store.draft_entry(session_id) else {
            return false;
        };
        let has_text = draft.get("text").and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty());
        has_text && now_millis() - at < TYPING_MS
    }

    /// 下面哪一层还没做完就先不叫醒：孙任务跑完，子任务还会接着做一轮。在等用户的不算，父任务要知道这件事。
    fn descendants_working(&self, parent_id: &str) -> bool {
        let Ok(entries) = self.store.task_entries() else {
            return false;
        };
        let parents: HashMap<&str, &str> = entries
            .iter()
            .filter_map(|entry| Some((entry.task.id.as_str(), entry.task.parent_task_id.as_deref()?)))
            .collect();
        let reports = self.reports();
        entries.iter().any(|entry| {
            let unfinished = match entry.attention.state {
                AttentionState::Working => true,
                AttentionState::NeedsInput => false,
                _ => reports.expecting(&entry.task.id),
            };
            unfinished
                && entry.task.archived_at.is_none()
                && aiwb_core::task::ancestors(&parents, &entry.task.id).any(|id| id == parent_id)
        })
    }

    /// 任务要删掉或归档了：它的结果和「还在起」都不再等，父任务可能因此可以叫醒了。
    pub(crate) async fn forget_subtask(&self, task_id: &str) {
        self.reports().forget(task_id);
        let parent = self.store.task(task_id).ok().flatten().and_then(|task| task.parent_task_id);
        if let Some(parent) = parent {
            self.flush_reports(&parent).await;
        }
    }

    pub(crate) fn revive_subtask(&self, task_id: &str) {
        self.reports().revive(task_id);
    }

    /// 回报正文：卡片结果在前，再是每个子任务的标题、状态、分支和最后一条回答。
    fn report_text(&self, batch: &Batch) -> String {
        let mut parts: Vec<String> = batch.notes.iter().map(|note| note.text.clone()).collect();
        if !batch.results.is_empty() {
            parts.push(
                "Subtasks have new results. Each result is the subtask's own claim: before telling the user something \
                 is done, read it with aiwb_subtask_read or look at the diff in its worktree. To combine several \
                 subtasks' changes, ask the user first and merge only on their yes; never push those branches."
                    .into(),
            );
        }
        for (task_id, outcome) in &batch.results {
            let task = self.store.task(task_id).ok().flatten();
            let title = task.as_ref().map_or("(deleted)", |task| task.title.as_str());
            let mut lines = vec![
                format!("## {title}"),
                format!("taskId: {task_id}"),
                format!("state: {}", status_label(outcome.status)),
            ];
            if let Some(branch) = task.as_ref().and_then(task_branch) {
                lines.push(format!("branch: {branch}"));
            }
            if outcome.status == SessionStatus::NeedsInput {
                lines.push(
                    "It is waiting for the user's approval or answer. Tell the user to handle it; never answer on their behalf."
                        .into(),
                );
            }
            if let Some(answer) = self.last_answer(task_id) {
                lines.push(format!("last answer:\n{answer}"));
            }
            parts.push(lines.join("\n"));
        }
        parts.join("\n\n")
    }

    fn last_answer(&self, task_id: &str) -> Option<String> {
        let session = self.store.task_sessions(task_id).ok()?.pop()?;
        let events = self.store.events_since(&session.id, 0).ok()?;
        let text = events.iter().rev().find_map(|stored| match &stored.event.body {
            SessionEventBody::AgentMessage {
                text, dedupe_of: None, ..
            } if !text.trim().is_empty() => Some(text.trim()),
            _ => None,
        })?;
        let mut chars = text.chars();
        let head: String = chars.by_ref().take(ANSWER_CHARS).collect();
        Some(if chars.next().is_some() { format!("{head}…") } else { head })
    }
}

/// 子任务的 Agent 有的、工作台排得出宽窄的权限档位。
fn supported_access(services: &Services, agent: AgentKind) -> Vec<String> {
    services
        .runtimes
        .adapter(agent)
        .draft_permission_menu()
        .presets
        .into_iter()
        .filter(|preset| preset.disabled_reason.is_none() && rank(&preset.id).is_some())
        .map(|preset| preset.id)
        .collect()
}

fn rank(mode: &str) -> Option<usize> {
    ACCESS_ORDER.iter().position(|item| *item == mode)
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

fn status_label(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Completed => "done",
        SessionStatus::Failed => "failed",
        SessionStatus::NeedsInput => "needs-input",
        SessionStatus::Stopped => "stopped",
        SessionStatus::Running => "working",
    }
}

/// 父任务发给子任务的只能是普通消息：斜杠命令能改子任务的权限和模式，绕过不比父任务宽的规则。
fn reject_command(text: &str) -> ServiceResult<()> {
    if text.trim_start().starts_with('/') {
        return Err("invalid: slash commands cannot be sent to a subtask".into());
    }
    Ok(())
}

/// 正在给这个父任务送回报。抢不到的一方留一笔「再看一遍」，放手时自动移除。
struct Flushing<'a> {
    parents: &'a Mutex<HashMap<String, bool>>,
    parent: String,
    /// `again` 已经放过手。之后同名的记录是别人的，`Drop` 不能删。
    released: std::cell::Cell<bool>,
}

impl<'a> Flushing<'a> {
    fn claim(parents: &'a Mutex<HashMap<String, bool>>, parent: &str) -> Option<Self> {
        let mut parents_now = parents.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(again) = parents_now.get_mut(parent) {
            *again = true;
            return None;
        }
        parents_now.insert(parent.to_string(), false);
        Some(Self {
            parents,
            parent: parent.to_string(),
            released: std::cell::Cell::new(false),
        })
    }

    /// 期间有人想送就清掉记号、返回 true；否则在同一把锁里放手，不会漏掉之后来的。
    fn again(&self) -> bool {
        let mut parents = self.parents.lock().unwrap_or_else(|p| p.into_inner());
        match parents.get_mut(&self.parent) {
            Some(again) if *again => {
                *again = false;
                true
            }
            _ => {
                parents.remove(&self.parent);
                self.released.set(true);
                false
            }
        }
    }
}

/// 中途被丢掉（没走到 `again` 放手）时清掉记录。
impl Drop for Flushing<'_> {
    fn drop(&mut self) {
        if !self.released.get() {
            self.parents.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.parent);
        }
    }
}

/// 正在给这个父任务开一批子任务，开完之前不叫醒它。放手时自动放开。
struct Held<'a> {
    services: &'a Services,
    parent: String,
}

impl<'a> Held<'a> {
    fn new(services: &'a Services, parent: &str) -> Self {
        services.reports().hold(parent);
        Self {
            services,
            parent: parent.to_string(),
        }
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.services.reports().release(&self.parent);
    }
}

/// 一批子任务开到一半失败：说明哪些已经开了，免得重试再开一遍。
fn partly_opened(err: String, opened: &[Value]) -> String {
    if opened.is_empty() {
        return err;
    }
    format!("{err}（已开出：{}，不要重开）", opened_list(opened))
}

/// 一张卡片正在开子任务。放手时自动移除。
struct Resolving<'a> {
    offers: &'a Mutex<HashSet<String>>,
    offer_id: String,
}

impl<'a> Resolving<'a> {
    fn claim(offers: &'a Mutex<HashSet<String>>, offer_id: &str) -> ServiceResult<Self> {
        if !offers.lock().unwrap_or_else(|p| p.into_inner()).insert(offer_id.to_string()) {
            return Err("这张卡片正在处理".into());
        }
        Ok(Self {
            offers,
            offer_id: offer_id.to_string(),
        })
    }
}

impl Drop for Resolving<'_> {
    fn drop(&mut self) {
        self.offers.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.offer_id);
    }
}

fn opened_list(opened: &[Value]) -> String {
    opened
        .iter()
        .map(|item| {
            format!(
                "{} (taskId: {})",
                item["title"].as_str().unwrap_or(""),
                item["taskId"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn sender_of(batch: &Batch) -> MessageSender {
    let mut task_ids: Vec<String> = Vec::new();
    let ids = batch
        .notes
        .iter()
        .flat_map(|note| note.task_ids.iter())
        .chain(batch.results.iter().map(|(id, _)| id));
    for id in ids {
        if !task_ids.contains(id) {
            task_ids.push(id.clone());
        }
    }
    MessageSender { task_ids }
}

/// 时间线里给父任务看的一条。`all` 时连工具调用、提问和错误也给。
fn timeline_item(body: &SessionEventBody, all: bool) -> Option<(&'static str, String)> {
    use aiwb_core::models::MessagePhase;
    match body {
        SessionEventBody::UserMessage { text, sender, .. } => {
            Some((if sender.is_some() { "parent" } else { "user" }, text.clone()))
        }
        SessionEventBody::AgentMessage {
            text,
            phase,
            dedupe_of: None,
            ..
        } if all || *phase != Some(MessagePhase::Commentary) => Some(("answer", text.clone())),
        SessionEventBody::PlanText { text, .. } => Some(("plan", text.clone())),
        SessionEventBody::PlanSteps { explanation, steps, .. } => {
            let mut lines: Vec<String> = Vec::new();
            if !explanation.is_empty() {
                lines.push(explanation.clone());
            }
            lines.extend(steps.iter().map(|step| format!("- [{:?}] {}", step.status, step.step)));
            Some(("plan", lines.join("\n")))
        }
        SessionEventBody::ToolCall { name, summary, status, .. } if all => {
            Some(("tool", format!("{name}: {summary} ({status:?})")))
        }
        SessionEventBody::Prompt { question, header, .. } if all => {
            Some(("prompt", if question.is_empty() { header.clone() } else { question.clone() }))
        }
        SessionEventBody::Error { message } if all => Some(("error", message.clone())),
        _ => None,
    }
}
