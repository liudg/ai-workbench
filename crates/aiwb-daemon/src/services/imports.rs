//! 从 CLI 历史导入会话。按 Agent 分页列出工作目录就是项目主目录的原生会话，导入时建任务、
//! 把整段时间线写进数据库，之后发消息用 resume 接回原线程。
//! 照 t3code `apps/server/src/project/AgentSessionImporter.ts`、`AgentSessionScanner.ts`：
//! 按项目根目录匹配，已经导入过的不再列出。

use std::collections::HashSet;

use aiwb_core::models::{cwd_key, new_id, AgentKind, SessionEventBody, SessionStatus};
use aiwb_core::timeline::title_from_user_message;
use aiwb_core::task::{SessionOptions, Task, TaskSession, TaskWorkspace};
use serde::{Deserialize, Serialize};

use aiwb_agents::AgentError;

use super::{ServiceResult, Services};

/// 一页至少凑够这么多条，除非这个 Agent 没有更早的了。
const PAGE_SIZE: usize = 30;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageParams {
    project_id: String,
    agent: AgentKind,
    cursor: Option<String>,
}

/// 可以导入的一条原生会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCandidate {
    agent: AgentKind,
    native_id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPage {
    items: Vec<ImportCandidate>,
    /// 还有更早的会话就给，原样传回取下一页。
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunImport {
    project_id: String,
    items: Vec<ImportCandidate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportFailure {
    agent: AgentKind,
    native_id: String,
    title: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    /// 新建的任务 id，按导入顺序。
    task_ids: Vec<String>,
    failures: Vec<ImportFailure>,
}

impl Services {
    /// 能导入会话的 Agent，同一个适配器只列一次。
    pub(crate) fn import_sources(&self) -> Vec<AgentKind> {
        let mut sources = Vec::new();
        for kind in AgentKind::all() {
            let adapter = self.runtimes.adapter(kind);
            if adapter.session_linked() && !sources.contains(&adapter.kind()) {
                sources.push(adapter.kind());
            }
        }
        sources
    }

    /// 一个 Agent 的一页，已经导入过的跳过。Agent 给的页被跳空了就接着往后取，凑够一页或者取完为止。
    pub(crate) async fn import_list(&self, params: PageParams) -> ServiceResult<ImportPage> {
        let project = self
            .store
            .project(&params.project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "项目不存在".to_string())?;
        let adapter = self.runtimes.adapter(params.agent);
        if !adapter.session_linked() {
            return Err(format!("{} 还不能在工作台里对话", params.agent.display_name()));
        }
        let agent = adapter.kind();
        let key = cwd_key(&project.path);
        let imported = self.imported_keys()?;
        let mut items = Vec::new();
        let mut cursor = params.cursor;
        loop {
            let page = adapter
                .import_page(&project.path, cursor.as_deref(), PAGE_SIZE)
                .await
                .map_err(reason)?;
            items.extend(
                page.entries
                    .into_iter()
                    .filter(|entry| entry.cwd_key == key)
                    .filter(|entry| !imported.contains(&(agent, entry.native_id.clone())))
                    .map(|entry| ImportCandidate {
                        agent,
                        native_id: entry.native_id,
                        title: entry.title,
                        created_at: entry.created_at,
                        updated_at: entry.updated_at,
                    }),
            );
            cursor = page.next_cursor;
            if items.len() >= PAGE_SIZE || cursor.is_none() {
                break;
            }
        }
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(ImportPage {
            items,
            next_cursor: cursor,
        })
    }

    /// 一条一条导入。某条失败不影响其他的，失败原因随结果返回。
    pub(crate) async fn run_import(&self, params: RunImport) -> ServiceResult<ImportResult> {
        let project = self
            .store
            .project(&params.project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "项目不存在".to_string())?;
        let mut task_ids = Vec::new();
        let mut failures = Vec::new();
        for item in params.items {
            match self.import_one(&project.id, &project.path, &item).await {
                Ok(task_id) => task_ids.push(task_id),
                Err(message) => failures.push(ImportFailure {
                    agent: item.agent,
                    native_id: item.native_id,
                    title: item.title,
                    message,
                }),
            }
        }
        self.runtimes.publish_tasks()?;
        Ok(ImportResult { task_ids, failures })
    }

    async fn import_one(
        &self,
        project_id: &str,
        cwd: &str,
        item: &ImportCandidate,
    ) -> ServiceResult<String> {
        if self.imported_keys()?.contains(&(item.agent, item.native_id.clone())) {
            return Err("已经导入过".into());
        }
        let adapter = self.runtimes.adapter(item.agent);
        if !adapter.session_linked() {
            return Err(format!("{} 还不能在工作台里对话", item.agent.display_name()));
        }
        let history = adapter
            .import_history(&item.native_id, cwd)
            .await
            .map_err(reason)?;
        let now = super::now_millis();
        let created_at = if item.created_at > 0 { item.created_at } else { now };
        let updated_at = item.updated_at.max(created_at);
        let title = match item.title.trim() {
            "" => history
                .iter()
                .find_map(|body| match body {
                    SessionEventBody::UserMessage {
                        text,
                        images,
                        annotations,
                        ..
                    } => title_from_user_message(text, images.len(), *annotations),
                    _ => None,
                })
                .unwrap_or_default(),
            title => title.to_string(),
        };
        let task = Task {
            id: new_id(),
            project_id: Some(project_id.to_string()),
            title,
            workspace: TaskWorkspace::Root,
            pinned: false,
            archived_at: None,
            created_at,
            updated_at,
            parent_task_id: None,
        };
        let session = TaskSession {
            id: new_id(),
            task_id: task.id.clone(),
            agent: item.agent,
            native_id: Some(item.native_id.clone()),
            status: SessionStatus::Completed,
            options: SessionOptions::default(),
            created_at,
            updated_at,
        };
        self.store
            .insert_task(&task, &session)
            .map_err(|e| e.to_string())?;
        if let Err(err) = self.runtimes.import_events(&session.id, history) {
            let _ = self.store.remove_task(&task.id);
            return Err(err);
        }
        Ok(task.id)
    }

    /// 已经在工作台里的原生会话：(Agent, 原生 id)。
    fn imported_keys(&self) -> ServiceResult<HashSet<(AgentKind, String)>> {
        Ok(self
            .store
            .list_sessions()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|session| session.native_id.map(|id| (session.agent, id)))
            .collect())
    }
}

/// 给人看的原因：CLI 报的原话，不加前缀。
fn reason(err: AgentError) -> String {
    match err {
        AgentError::Runtime(message) => message,
        other => other.to_string(),
    }
}
