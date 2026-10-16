//! 每个 Agent 一份会话目录。SessionManager 只做并集，不认识某一种 CLI。
//!
//! 侧边栏里的项目只来自工作台已保存的列表。某个项目下的会话，是各目录里
//! cwd 对上该项目路径的条目。键是 `agent kind + native id`。同一个原生 id
//! 出现在两个 Agent 名下时，仍是两条会话。

use async_trait::async_trait;

use crate::models::{strip_verbatim_prefix, AgentKind, Project, Session, SessionStatus};

/// 某个 Agent 能 resume 的一条原生会话。
#[derive(Debug, Clone)]
pub struct DirectoryEntry {
    pub native_id: String,
    /// 原始工作目录。侧边栏用 `cwd_key` 匹配，这个字段留给目录实现和调试。
    #[allow(dead_code)]
    pub cwd: String,
    pub cwd_key: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: SessionStatus,
    pub ephemeral: bool,
    /// `thread/list` 的 `archived`。默认侧栏不展示，收在「已归档」里。
    pub archived: bool,
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

/// 侧边栏项目只含工作台已保存的列表。Agent 目录里的其它 cwd 不会变成项目。
pub fn group_projects(stored: &[Project]) -> Vec<Project> {
    stored
        .iter()
        .map(|project| {
            let mut project = project.clone();
            project.external = false;
            project
        })
        .collect()
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
            archived: item.entry.archived,
        })
        .collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    sessions
}

pub fn cwd_key(path: &str) -> String {
    let stripped = strip_verbatim_prefix(path.trim());
    let trimmed = stripped.trim_end_matches(['\\', '/']);
    // Windows 路径不区分大小写。带盘符或 UNC 的字符串在任何宿主上都按这个规则折叠，
    // 避免同一目录因为 `F:\App` / `f:\app` 对不上。POSIX 路径保持原样。
    if cfg!(windows) || looks_like_windows_path(trimmed) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn looks_like_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path.starts_with(r"\\")
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
            standalone: false,
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
                archived: false,
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
    fn sidebar_projects_are_only_registered() {
        let stored = vec![project("saved", r"F:\app")];
        let listed = vec![
            sourced(AgentKind::CodexCli, "inside", r"f:\app", 50),
            sourced(AgentKind::CodexCli, "outside", r"D:\other\demo", 80),
            sourced(AgentKind::ClaudeCode, "outside-2", r"D:\other\demo", 90),
        ];
        let projects = group_projects(&stored);
        assert_eq!(projects.len(), 1);
        assert!(!projects[0].external);
        assert_eq!(projects[0].id, "saved");
        assert!(projects.iter().all(|item| item.name != "demo"));

        let saved_sessions = sessions_for_project(&projects[0], &listed);
        assert_eq!(saved_sessions.len(), 1);
        assert_eq!(saved_sessions[0].id, "codex-cli:inside");
        assert_eq!(saved_sessions[0].native_id, "inside");
        assert_eq!(saved_sessions[0].project_id, "saved");
    }

    #[test]
    fn agent_directories_do_not_become_projects() {
        let listed = vec![sourced(AgentKind::CodexCli, "outside", r"D:\other\demo", 80)];
        assert!(group_projects(&[]).is_empty());
        let stored = project("saved", r"F:\app");
        assert!(sessions_for_project(&stored, &listed).is_empty());
    }

    #[test]
    fn skips_ephemeral_threads_for_a_registered_project() {
        let stored = project("saved", r"F:\scratch");
        let mut ghost = sourced(AgentKind::CodexCli, "temp", r"F:\scratch", 10);
        ghost.entry.ephemeral = true;
        assert!(group_projects(&[]).is_empty());
        assert!(sessions_for_project(&stored, &[ghost]).is_empty());
    }

    #[test]
    fn unions_agents_that_share_a_native_id() {
        let stored = [project("saved", r"F:\app")];
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

    #[test]
    fn archived_flag_is_copied_onto_the_session() {
        let stored = project("saved", r"F:\app");
        let mut row = sourced(AgentKind::CodexCli, "old", r"F:\app", 10);
        row.entry.archived = true;
        let sessions = sessions_for_project(&stored, &[row]);
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].archived);
    }
}
