//! 每个 Agent 一份会话目录。SessionManager 只做并集，不认识某一种 CLI。
//!
//! 侧边栏条目的键是 `agent kind + native id`。同一个原生 id 出现在两个 Agent
//! 名下时，仍是两条会话。

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;

use crate::models::{strip_verbatim_prefix, AgentKind, Project, Session, SessionStatus};

/// 某个 Agent 能 resume 的一条原生会话。
#[derive(Debug, Clone)]
pub struct DirectoryEntry {
    pub native_id: String,
    pub cwd: String,
    pub cwd_key: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: SessionStatus,
    pub ephemeral: bool,
}

/// 列出 / 失效一个 Agent 的原生会话。实现可以是空列表（Claude 桩）。
#[async_trait]
pub trait SessionDirectory: Send + Sync {
    fn kind(&self) -> AgentKind;

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String>;

    async fn invalidate(&self);
}

/// 目录行加上它所属的 Agent，供侧边栏并集使用。
#[derive(Debug, Clone)]
pub struct SourcedEntry {
    pub agent: AgentKind,
    pub entry: DirectoryEntry,
}

pub fn session_key(agent: AgentKind, native_id: &str) -> String {
    format!("{}:{native_id}", agent.as_str())
}

/// 已保存的项目在前；各 Agent 目录里出现、但还没导入的目录按最近更新排在后面。
pub fn group_projects(stored: &[Project], listed: &[SourcedEntry]) -> Vec<Project> {
    let mut seen = HashSet::new();
    let mut projects = Vec::with_capacity(stored.len());
    for project in stored {
        let mut project = project.clone();
        project.external = false;
        seen.insert(cwd_key(&project.path));
        projects.push(project);
    }

    struct Slot {
        cwd: String,
        created: i64,
        updated: i64,
        agent: AgentKind,
    }

    let mut discovered: HashMap<String, Slot> = HashMap::new();
    for item in listed {
        let thread = &item.entry;
        if thread.ephemeral || seen.contains(&thread.cwd_key) {
            continue;
        }
        let slot = discovered
            .entry(thread.cwd_key.clone())
            .or_insert_with(|| Slot {
                cwd: thread.cwd.clone(),
                created: thread.created_at,
                updated: thread.updated_at,
                agent: item.agent,
            });
        if thread.created_at > 0 && (slot.created == 0 || thread.created_at < slot.created) {
            slot.created = thread.created_at;
        }
        if thread.updated_at > slot.updated {
            slot.updated = thread.updated_at;
            slot.agent = item.agent;
        }
    }

    let mut extra: Vec<Project> = discovered
        .into_iter()
        .map(|(key, slot)| Project {
            id: virtual_project_id(&key),
            name: folder_name(&slot.cwd),
            path: slot.cwd,
            default_agent: slot.agent,
            created_at: slot.created,
            updated_at: slot.updated,
            external: true,
        })
        .collect();
    extra.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    projects.extend(extra);
    projects
}

pub fn sessions_for_project(project: &Project, listed: &[SourcedEntry]) -> Vec<Session> {
    let key = cwd_key(&project.path);
    let mut sessions: Vec<Session> = listed
        .iter()
        .filter(|item| !item.entry.ephemeral && item.entry.cwd_key == key)
        .map(|item| Session {
            id: session_key(item.agent, &item.entry.native_id),
            project_id: project.id.clone(),
            agent: item.agent,
            native_id: item.entry.native_id.clone(),
            title: item.entry.title.clone(),
            status: item.entry.status,
            created_at: item.entry.created_at,
            updated_at: item.entry.updated_at,
        })
        .collect();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

pub fn virtual_project_id(key: &str) -> String {
    if key.is_empty() {
        "dir:(unknown)".into()
    } else {
        format!("dir:{key}")
    }
}

pub fn cwd_key(path: &str) -> String {
    let stripped = strip_verbatim_prefix(path.trim());
    let trimmed = stripped.trim_end_matches(['\\', '/']);
    #[cfg(windows)]
    {
        trimmed.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        trimmed.to_string()
    }
}

fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("未知目录")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, path: &str) -> Project {
        Project {
            id: id.into(),
            name: "已保存".into(),
            path: path.into(),
            default_agent: AgentKind::CodexCli,
            created_at: 1,
            updated_at: 2,
            external: false,
        }
    }

    fn sourced(agent: AgentKind, id: &str, cwd: &str, updated: i64) -> SourcedEntry {
        SourcedEntry {
            agent,
            entry: DirectoryEntry {
                native_id: id.into(),
                cwd_key: cwd_key(cwd),
                cwd: cwd.into(),
                title: id.into(),
                created_at: updated - 10,
                updated_at: updated,
                status: SessionStatus::Completed,
                ephemeral: false,
            },
        }
    }

    #[test]
    fn cwd_key_ignores_verbatim_prefix_and_case() {
        assert_eq!(cwd_key(r"\\?\F:\App\"), cwd_key(r"f:\app"));
    }

    #[test]
    fn session_keys_include_agent_kind() {
        assert_eq!(session_key(AgentKind::CodexCli, "abc"), "codex-cli:abc");
        assert_ne!(
            session_key(AgentKind::CodexCli, "abc"),
            session_key(AgentKind::ClaudeCode, "abc")
        );
    }

    #[test]
    fn groups_resume_cwds_without_replacing_saved_projects() {
        let stored = vec![project("saved", r"F:\app")];
        let listed = vec![
            sourced(AgentKind::CodexCli, "inside", r"f:\app", 50),
            sourced(AgentKind::CodexCli, "outside", r"D:\other\demo", 80),
            sourced(AgentKind::CodexCli, "outside-2", r"D:\other\demo", 90),
        ];
        let projects = group_projects(&stored, &listed);
        assert_eq!(projects.len(), 2);
        assert!(!projects[0].external);
        assert_eq!(projects[0].id, "saved");
        assert!(projects[1].external);
        assert_eq!(projects[1].name, "demo");
        assert_eq!(
            projects[1].id,
            virtual_project_id(&cwd_key(r"D:\other\demo"))
        );

        let saved_sessions = sessions_for_project(&projects[0], &listed);
        assert_eq!(saved_sessions.len(), 1);
        assert_eq!(saved_sessions[0].id, "codex-cli:inside");
        assert_eq!(saved_sessions[0].native_id, "inside");
        assert_eq!(saved_sessions[0].project_id, "saved");

        let external_sessions = sessions_for_project(&projects[1], &listed);
        assert_eq!(external_sessions.len(), 2);
        assert_eq!(external_sessions[0].id, "codex-cli:outside-2");
    }

    #[test]
    fn skips_ephemeral_threads_when_grouping() {
        let mut ghost = sourced(AgentKind::CodexCli, "temp", r"F:\scratch", 10);
        ghost.entry.ephemeral = true;
        let projects = group_projects(&[], &[ghost]);
        assert!(projects.is_empty());
    }

    #[test]
    fn unions_agents_that_share_a_native_id() {
        let stored = vec![project("saved", r"F:\app")];
        let listed = vec![
            sourced(AgentKind::CodexCli, "same", r"F:\app", 10),
            sourced(AgentKind::ClaudeCode, "same", r"F:\app", 30),
        ];
        let sessions = sessions_for_project(&stored[0], &listed);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, "claude-code:same");
        assert_eq!(sessions[1].id, "codex-cli:same");
        assert_eq!(sessions[0].native_id, sessions[1].native_id);
    }
}
