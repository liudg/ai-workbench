//! Agent 经工作台 MCP 开会话：按调用方补全设置、要不要先问用户、用户在卡片上的选择。
//! 开出来的会话挂在调用方下面（[`SessionLink::Child`]，之后的回报和操控在 `subtasks`），或者是独立的顶层会话。
//! 工具层在 `crate::mcp::sessions`。

use std::collections::HashSet;
use std::sync::Mutex;

use aiwb_core::models::{now_millis, AgentKind, SessionEventBody};
use aiwb_core::task::{
    Initiation, OfferResolution, SessionAccess, SessionLink, SessionOptions, SessionSpec, Task, TaskSession,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::subtasks::reject_command;
use super::tasks::CreateTask;
use super::{Caller, ServiceResult, Services};
use crate::runtime::task_branch;

/// 工作台统一的权限档位，从窄到宽。
const ACCESS_ORDER: [&str; 4] = ["read-only", "ask", "approve-for-me", "full"];
/// 自己提议的卡片一个回合最多几张。
const MAX_PROPOSALS_PER_TURN: usize = 3;
/// 不分叉的会话，`background` 至少这么多字。照 Claude Code 桌面版 `start_session`。
const MIN_BACKGROUND_CHARS: usize = 80;
/// 自己提议的卡片多久没点就过期。
const PROPOSAL_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Agent 要开的一个会话，还没按调用方的规则补全。
pub(crate) struct SessionRequest {
    pub(crate) agent: Option<AgentKind>,
    pub(crate) title: String,
    pub(crate) prompt: String,
    pub(crate) background: Option<String>,
    pub(crate) fork: bool,
    pub(crate) worktree: bool,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) access: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveOffer {
    session_id: String,
    offer_id: String,
    accept: bool,
}

/// 正在开会话的卡片。两个窗口同时点也只开一次。
#[derive(Default)]
pub(crate) struct ResolvingOffers(Mutex<HashSet<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedSession {
    task_id: String,
    title: String,
    agent: AgentKind,
    branch: Option<String>,
}

impl Services {
    /// 能用的 Agent 和它们的目录，以及调用方自己现在的设置。
    pub(crate) fn agent_capabilities(&self, caller: &Caller) -> ServiceResult<Value> {
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
                    "fork": adapter.capabilities().supports_fork,
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

    /// 开会话。`user_asked` 直接开；另外两种先在调用方的时间线里出卡片。
    pub(crate) async fn create_sessions(
        &self,
        caller: &Caller,
        link: SessionLink,
        initiation: Initiation,
        requests: Vec<SessionRequest>,
    ) -> ServiceResult<Value> {
        if requests.is_empty() {
            return Err("invalid: give at least one session".into());
        }
        // 独立聊天没有仓库，它开的会话也就没有工作树。
        if caller.task.project_id.is_none() && requests.iter().any(|request| request.worktree) {
            return Err("invalid: this chat has no git repository, so the sessions it opens cannot get a worktree".into());
        }
        let specs = requests
            .into_iter()
            .map(|request| self.session_spec(&caller.session, link, request))
            .collect::<ServiceResult<Vec<_>>>()?;
        match initiation {
            // 开到一半失败也算一个结果，按 clientRequestId 重试时直接给它，不再重开。
            Initiation::UserAsked => {
                let (opened, error) = self.open_sessions(&caller.task, &caller.session.id, link, &specs).await;
                if !opened.is_empty() {
                    self.record_opened(&caller.session.id, link, specs, &opened)?;
                }
                match (opened, error) {
                    (opened, None) => Ok(opened_reply("opened", link, opened)),
                    (opened, Some(err)) if opened.is_empty() => Err(err),
                    (opened, Some(err)) => {
                        let mut reply = opened_reply("partly_opened", link, opened);
                        reply["error"] = json!(err);
                        Ok(reply)
                    }
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
                        link,
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

    /// 直接开出的会话也在调用方的时间线里留一条，和选过「另开」的卡片一样画成会话行。
    fn record_opened(
        &self,
        session_id: &str,
        link: SessionLink,
        specs: Vec<SessionSpec>,
        opened: &[OpenedSession],
    ) -> ServiceResult<()> {
        self.runtimes.record(
            session_id,
            SessionEventBody::SubtaskOffer {
                offer_id: aiwb_core::models::new_id(),
                link,
                initiation: Initiation::UserAsked,
                subtasks: specs,
                expires_at: None,
                resolution: Some(OfferResolution::Accepted {
                    task_ids: opened_ids(opened),
                }),
            },
        )?;
        Ok(())
    }

    /// 按调用方补全：Agent 缺省和调用方一样，权限缺省继承且不能更宽，调用方在计划模式时新会话也是。
    /// 独立会话一样受这些限制，否则 Agent 能借它绕开自己的权限。
    fn session_spec(&self, caller: &TaskSession, link: SessionLink, request: SessionRequest) -> ServiceResult<SessionSpec> {
        let agent = request.agent.unwrap_or(caller.agent);
        let adapter = self.runtimes.adapter(agent);
        if !adapter.session_linked() {
            return Err(format!("unsupported_agent: {} cannot chat in the workbench yet", agent.display_name()));
        }
        let title = request.title.trim().to_string();
        let prompt = request.prompt.trim().to_string();
        match link {
            SessionLink::Child if title.is_empty() || prompt.is_empty() => {
                return Err("invalid: every subtask needs a title and a prompt".into());
            }
            SessionLink::Detached if title.is_empty() => {
                return Err("invalid: every session needs a title".into());
            }
            _ => {}
        }
        reject_command(&prompt)?;
        let background = nonempty(request.background);
        if request.fork {
            check_fork(caller, adapter.capabilities().supports_fork, agent, &request.worktree, &prompt, &request.model, &request.effort)?;
        } else if !prompt.is_empty() && background.as_deref().is_none_or(|text| text.chars().count() < MIN_BACKGROUND_CHARS) {
            return Err(format!(
                "invalid: a session that does not fork needs background of at least {MIN_BACKGROUND_CHARS} characters: \
                 the overall goal, decisions and constraints so far, how this piece fits"
            ));
        }
        let plan = caller.options.collaboration_mode.as_deref() == Some("plan");
        if plan && !adapter.capabilities().supports_plan {
            return Err(format!(
                "plan_mode: you are in plan mode, so the sessions you open must be too, and {} has no plan mode",
                agent.display_name()
            ));
        }
        Ok(SessionSpec {
            agent,
            title,
            prompt,
            background: background.filter(|_| !request.fork),
            fork: request.fork,
            worktree: request.worktree,
            options: SessionOptions {
                model: nonempty(request.model),
                effort: nonempty(request.effort),
                access: Some(self.inherited_access(caller, agent, request.access.as_deref())?),
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

    /// 照 t3code `resolveRuntimeMode`：指定的档位比调用方宽就拒绝（`runtime_mode_escalation_denied`）。
    /// 没指定时继承调用方的；新会话的 Agent 没有这一档时取它有的、不比调用方宽的最宽一档。
    fn inherited_access(&self, caller: &TaskSession, agent: AgentKind, requested: Option<&str>) -> ServiceResult<SessionAccess> {
        let caller_mode = self.access_mode_of(caller);
        // 具名配置档排不出宽窄，按询问批准算。
        let ceiling = rank(&caller_mode).unwrap_or(1);
        let supported = supported_access(self, agent);
        let mode = match requested.map(str::trim).filter(|mode| !mode.is_empty()) {
            Some(mode) => {
                let wanted = rank(mode).ok_or_else(|| format!("invalid: unknown permission level {mode}"))?;
                if wanted > ceiling {
                    return Err(format!(
                        "permission_escalation: a session you open cannot have wider permissions than yours (you have {caller_mode}, asked for {mode})"
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
        if agent == caller.agent && mode == caller_mode {
            if let Some(access) = caller.options.access.clone() {
                return Ok(access);
            }
        }
        Ok(SessionAccess {
            mode,
            ..Default::default()
        })
    }

    /// 卡片可能放了好几天：开之前按调用方现在的权限和计划模式再看一遍。
    fn still_within(&self, caller: &TaskSession, spec: &SessionSpec) -> ServiceResult<()> {
        let ceiling = rank(&self.access_mode_of(caller)).unwrap_or(1);
        let mode = spec.options.access.as_ref().map_or("full", |access| access.mode.as_str());
        let plan = caller.options.collaboration_mode.as_deref() == Some("plan");
        if rank(mode).is_none_or(|wanted| wanted > ceiling)
            || (plan && spec.options.collaboration_mode.as_deref() != Some("plan"))
        {
            return Err("当前会话的权限已经收窄，这张卡片不能再开".into());
        }
        Ok(())
    }

    /// 自己提议的卡片：一个回合最多几张，同一件事不重复提。
    fn check_proposal(&self, session: &TaskSession, specs: &[SessionSpec]) -> ServiceResult<()> {
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

    /// 开出会话，第一条消息由 `create_task` 在后台发出。中途失败时返回已经开出的和错误。
    /// 挂在下面的开完之前先压着回报，一批里先跑完的不会单独回报；调用中途被丢掉（客户端断开）时靠守卫放开。
    async fn open_sessions(
        &self,
        origin: &Task,
        origin_session_id: &str,
        link: SessionLink,
        specs: &[SessionSpec],
    ) -> (Vec<OpenedSession>, Option<String>) {
        let child = link == SessionLink::Child;
        let _held = child.then(|| self.hold_reports(&origin.id));
        let notes = match child.then(|| self.session_notes_folder(origin)).transpose() {
            Ok(notes) => notes,
            Err(err) => return (Vec::new(), Some(err)),
        };
        let mut opened = Vec::new();
        for spec in specs {
            let result = if spec.fork {
                self.fork_for_agent(origin, origin_session_id, link, spec, notes.clone()).await
            } else {
                self.create_task(CreateTask::from_agent(origin, link, spec, notes.clone())).await
            };
            let entry = match result {
                Ok(entry) => entry,
                Err(err) => return (opened, Some(err)),
            };
            if child {
                self.expect_report(&origin.id, &entry.task.id);
            }
            opened.push(OpenedSession {
                branch: task_branch(&entry.task),
                task_id: entry.task.id,
                title: entry.task.title,
                agent: spec.agent,
            });
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
        let _resolving = Resolving::claim(&self.resolving_offers, &params.offer_id)?;
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
            link,
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
        let mut failed = None;
        let (resolution, note) = if params.accept {
            let current = self
                .store
                .task_sessions(&task.id)
                .map_err(store_err)?
                .pop()
                .ok_or_else(|| "任务没有会话".to_string())?;
            if current.id != session.id && subtasks.iter().any(|spec| spec.fork) {
                return Err("发起分叉的会话已切换，请重新发起分叉".into());
            }
            for spec in &subtasks {
                self.still_within(&current, spec)?;
            }
            let (opened, error) = self.open_sessions(&task, &session.id, link, &subtasks).await;
            if opened.is_empty() {
                return Err(error.unwrap_or_else(|| "没有开出会话".into()));
            }
            failed = error.map(|err| partly_opened(err, &opened));
            let ids = opened_ids(&opened);
            let note = accepted_note(link, initiation, &opened).map(|text| (text, ids.clone()));
            (OfferResolution::Accepted { task_ids: ids }, note)
        } else {
            let titles = subtasks.iter().map(|spec| spec.title.as_str()).collect::<Vec<_>>().join(", ");
            // 自己提议的被拒，Agent 本来就没等，不用告诉它。
            let note = (initiation == Initiation::Offer).then(|| {
                let place = match link {
                    SessionLink::Child => "a subtask",
                    SessionLink::Detached => "a new session",
                };
                (format!("The user chose to do this here instead of in {place}. Do it yourself now: {titles}."), Vec::new())
            });
            (OfferResolution::Declined, note)
        };
        self.runtimes.rewrite(
            &session.id,
            &stored.event.id,
            SessionEventBody::SubtaskOffer {
                offer_id,
                link,
                initiation,
                subtasks,
                expires_at,
                resolution: Some(resolution),
            },
        )?;
        if let Some((text, task_ids)) = note {
            self.send_note(&task.id, text, task_ids).await;
        }
        failed.map_or(Ok(()), Err)
    }
}

impl Services {
    /// 这组嵌套会话共用的笔记目录，按最上面的任务分。照 Claude Code 桌面版的 side-session-notes。
    fn session_notes_folder(&self, origin: &Task) -> ServiceResult<String> {
        let mut root = origin.clone();
        while let Some(parent) = root.parent_task_id.as_deref() {
            match self.store.task(parent).map_err(|e| e.to_string())? {
                Some(task) => root = task,
                None => break,
            }
        }
        let folder = self.session_notes_root.join(&root.id);
        std::fs::create_dir_all(&folder).map_err(|e| format!("无法创建笔记目录：{e}"))?;
        Ok(folder.to_string_lossy().into_owned())
    }

    /// 删除任务前保留候选目录；引用随时间线一起删除后，再检查其他会话是否仍在用。
    pub(super) fn task_session_notes(&self, task_id: &str) -> ServiceResult<Vec<String>> {
        let mut folders = self.store.task_note_folders(task_id).map_err(|e| e.to_string())?;
        folders.push(self.session_notes_root.join(task_id).to_string_lossy().into_owned());
        folders.sort();
        folders.dedup();
        Ok(folders)
    }

    pub(super) fn remove_unused_session_notes(&self, folders: &[String]) -> ServiceResult<()> {
        for folder in folders {
            let path = std::path::Path::new(folder);
            // 只清理工作台自己的笔记目录，历史消息中的外部路径不动。
            if path.parent() != Some(self.session_notes_root.as_path()) || !path.is_dir() {
                continue;
            }
            let Some(owner) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if self.store.task(owner).map_err(|e| e.to_string())?.is_some()
                || self.store.session_notes_in_use(folder).map_err(|e| e.to_string())?
            {
                continue;
            }
            std::fs::remove_dir_all(path).map_err(|e| format!("无法删除笔记目录：{e}"))?;
        }
        Ok(())
    }
}

/// 分叉带着完整对话留在同一个 Agent 上，工作树、模型和强度也跟着来，不能另选。
fn check_fork(
    caller: &TaskSession,
    supported: bool,
    agent: AgentKind,
    worktree: &bool,
    prompt: &str,
    model: &Option<String>,
    effort: &Option<String>,
) -> ServiceResult<()> {
    if agent != caller.agent {
        return Err("invalid: a fork stays on your own agent; to use another agent, do not fork and give background".into());
    }
    if !supported {
        return Err(format!("fork_unsupported: {} cannot fork; do not fork and give background", agent.display_name()));
    }
    if prompt.is_empty() {
        return Err("invalid: a fork needs a prompt".into());
    }
    if *worktree || model.is_some() || effort.is_some() {
        return Err("invalid: worktree, model and effort cannot be set on a fork".into());
    }
    Ok(())
}

/// 新会话要能写共享笔记目录。
pub(super) fn with_notes(mut options: SessionOptions, notes: Option<&str>) -> SessionOptions {
    if let (Some(access), Some(notes)) = (options.access.as_mut(), notes) {
        if !access.writable_roots.iter().any(|root| root == notes) {
            access.writable_roots.push(notes.to_string());
        }
    }
    options
}

/// 用户选了另开之后告诉 Agent 什么。独立会话的结果不回来，自己提议的 Agent 本来就没等，不用告诉它。
fn accepted_note(link: SessionLink, initiation: Initiation, opened: &[OpenedSession]) -> Option<String> {
    match (link, initiation) {
        (SessionLink::Child, _) => Some(format!(
            "The user chose to split this off. Opened subtasks: {}. Their results will come back to you; do not wait for them.",
            opened_list(opened)
        )),
        (SessionLink::Detached, Initiation::Offer) => Some(format!(
            "The user chose to open this as a separate session: {}. It is independent of this conversation and nothing will come back to you.",
            opened_list(opened)
        )),
        (SessionLink::Detached, _) => None,
    }
}

fn opened_reply(status: &str, link: SessionLink, opened: Vec<OpenedSession>) -> Value {
    match link {
        SessionLink::Child => json!({ "status": status, "subtasks": opened }),
        SessionLink::Detached => json!({
            "status": status,
            "sessions": opened,
            "next": "These sessions are independent of this conversation; their results will not come back to you.",
        }),
    }
}

/// 新会话的 Agent 有的、工作台排得出宽窄的权限档位。
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

/// 一批会话开到一半失败：说明哪些已经开了，免得重试再开一遍。
fn partly_opened(err: String, opened: &[OpenedSession]) -> String {
    format!("{err}（已开出：{}，不要重开）", opened_list(opened))
}

/// 一张卡片正在开会话。放手时自动移除。
struct Resolving<'a> {
    offers: &'a ResolvingOffers,
    offer_id: String,
}

impl<'a> Resolving<'a> {
    fn claim(offers: &'a ResolvingOffers, offer_id: &str) -> ServiceResult<Self> {
        if !offers.0.lock().unwrap_or_else(|p| p.into_inner()).insert(offer_id.to_string()) {
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
        self.offers.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.offer_id);
    }
}

fn opened_ids(opened: &[OpenedSession]) -> Vec<String> {
    opened
        .iter()
        .map(|item| item.task_id.clone())
        .collect()
}

fn opened_list(opened: &[OpenedSession]) -> String {
    opened
        .iter()
        .map(|item| format!("{} (taskId: {})", item.title, item.task_id))
        .collect::<Vec<_>>()
        .join(", ")
}
