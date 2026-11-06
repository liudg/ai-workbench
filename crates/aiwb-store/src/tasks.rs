//! 任务、会话和事件日志。

use std::collections::HashMap;

use aiwb_core::attention::Attention;
use aiwb_core::models::{AgentKind, SessionEvent, SessionEventBody, SessionStatus};
use aiwb_core::task::{SessionOptions, StoredEvent, Task, TaskEntry, TaskSession, TaskWorkspace};
use rusqlite::{params, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::attention::put_attention;
use crate::{Store, StoreError, StoreResult};

fn to_text<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("serialize column")
}

/// 枚举存成不带引号的字符串，查询时好读。
pub(crate) fn enum_text<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value).expect("serialize enum") {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    }
}

fn from_text<T: DeserializeOwned>(column: &str, raw: &str) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("{column}: {err}").into(),
        )
    })
}

pub(crate) fn from_enum<T: DeserializeOwned>(column: &str, raw: &str) -> rusqlite::Result<T> {
    from_text(column, &serde_json::Value::String(raw.to_string()).to_string())
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let workspace: String = row.get("workspace")?;
    Ok(Task {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        workspace: from_text::<TaskWorkspace>("workspace", &workspace)?,
        parent_task_id: row.get("parent_task_id")?,
        pinned: row.get("pinned")?,
        archived_at: row.get("archived_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<TaskSession> {
    let agent: String = row.get("agent")?;
    let status: String = row.get("status")?;
    let options: String = row.get("options")?;
    Ok(TaskSession {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        agent: from_enum::<AgentKind>("agent", &agent)?,
        native_id: row.get("native_id")?,
        status: from_enum::<SessionStatus>("status", &status)?,
        options: from_text::<SessionOptions>("options", &options)?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<StoredEvent> {
    let body: String = row.get("body")?;
    let seq: i64 = row.get("seq")?;
    let rev: i64 = row.get("rev")?;
    Ok(StoredEvent {
        event: SessionEvent {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            seq: seq as u64,
            ts: row.get("ts")?,
            body: from_text::<SessionEventBody>("body", &body)?,
        },
        rev: rev as u64,
    })
}

impl Store {
    /// 新建任务和它的第一个会话，在同一个事务里。
    pub fn insert_task(&self, task: &Task, session: &TaskSession) -> StoreResult<()> {
        self.insert_task_with_messages(task, session, &[])
    }

    /// 创建和已接收的消息一起提交，订阅者不会看见缺少说明的任务。
    pub fn insert_task_with_messages(&self, task: &Task, session: &TaskSession, messages: &[SessionEventBody]) -> StoreResult<()> {
        if session.task_id != task.id {
            return Err(StoreError::Invalid("会话不属于这个任务".into()));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO task (id, project_id, title, workspace, parent_task_id, pinned, archived_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                task.id,
                task.project_id,
                task.title,
                to_text(&task.workspace),
                task.parent_task_id,
                task.pinned,
                task.archived_at,
                task.created_at,
                task.updated_at
            ],
        )?;
        insert_session(&tx, session)?;
        for (index, body) in messages.iter().enumerate() {
            let seq = (index + 1) as i64;
            tx.execute(
                "INSERT INTO event (session_id, seq, rev, id, ts, body) VALUES (?1, ?2, ?2, ?3, ?4, ?5)",
                params![session.id, seq, aiwb_core::models::new_id(), session.created_at, to_text(body)],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 未归档的在前，各自按最近更新排列。
    pub fn list_tasks(&self) -> StoreResult<Vec<Task>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM task ORDER BY archived_at IS NOT NULL, updated_at DESC, id",
        )?;
        let rows = stmt.query_map([], task_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 任务列表主题的内容：每个任务带上它的会话，和现在用的会话的注意力。
    pub fn task_entries(&self) -> StoreResult<Vec<TaskEntry>> {
        let mut sessions = self.list_sessions()?;
        let mut sides: HashMap<String, Vec<TaskSession>> = HashMap::new();
        for session in self.side_sessions()? {
            sides.entry(session.task_id.clone()).or_default().push(session);
        }
        let mut attention: HashMap<String, Attention> = self.attention_rows()?.into_iter().collect();
        Ok(self
            .list_tasks()?
            .into_iter()
            .map(|task| {
                let (mine, rest): (Vec<_>, Vec<_>) =
                    sessions.drain(..).partition(|session| session.task_id == task.id);
                sessions = rest;
                let attention = match mine.last() {
                    Some(current) => attention
                        .remove(&current.id)
                        .unwrap_or_else(|| Attention::from_status(current.status, current.updated_at)),
                    None => Attention::from_status(SessionStatus::Stopped, task.updated_at),
                };
                TaskEntry {
                    sides: sides.remove(&task.id).unwrap_or_default(),
                    task,
                    sessions: mine,
                    attention,
                    branch: None,
                }
            })
            .collect())
    }

    pub fn task(&self, id: &str) -> StoreResult<Option<Task>> {
        Ok(self
            .conn()
            .query_row("SELECT * FROM task WHERE id = ?1", [id], task_from_row)
            .optional()?)
    }

    pub fn set_task_title(&self, id: &str, title: &str, now: i64) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE task SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now],
        )? > 0)
    }

    pub fn set_task_pinned(&self, id: &str, pinned: bool) -> StoreResult<bool> {
        Ok(self
            .conn()
            .execute("UPDATE task SET pinned = ?2 WHERE id = ?1", params![id, pinned])?
            > 0)
    }

    pub fn set_task_archived(&self, id: &str, archived_at: Option<i64>, now: i64) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE task SET archived_at = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, archived_at, now],
        )? > 0)
    }

    /// 只换工作区（清理、恢复工作树时），不算任务的更新。
    pub fn set_task_workspace(&self, id: &str, workspace: &TaskWorkspace) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE task SET workspace = ?2 WHERE id = ?1",
            params![id, to_text(workspace)],
        )? > 0)
    }

    /// 记一次活动：最后活动时间往后挪，不往前。
    pub fn touch_task(&self, id: &str, now: i64) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE task SET updated_at = MAX(updated_at, ?2) WHERE id = ?1",
            params![id, now],
        )? > 0)
    }

    pub fn remove_task(&self, id: &str) -> StoreResult<bool> {
        Ok(self.conn().execute("DELETE FROM task WHERE id = ?1", [id])? > 0)
    }

    /// 任务的会话段，不含侧边聊天。
    pub fn list_sessions(&self) -> StoreResult<Vec<TaskSession>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM session WHERE side = 0 ORDER BY created_at, id")?;
        let rows = stmt.query_map([], session_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 一个任务的会话，按建立的先后。最后一个是现在用的，前面的是换 Agent 之前的。
    pub fn task_sessions(&self, task_id: &str) -> StoreResult<Vec<TaskSession>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT * FROM session WHERE task_id = ?1 AND side = 0 ORDER BY created_at, id")?;
        let rows = stmt.query_map([task_id], session_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 给已有任务添一个会话（中途换 Agent）。
    pub fn add_session(&self, session: &TaskSession) -> StoreResult<()> {
        insert_session(&self.conn(), session)
    }

    /// 给任务增加一个独立的侧边聊天。
    pub fn add_side_session(&self, session: &TaskSession) -> StoreResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        insert_session(&tx, session)?;
        tx.execute("UPDATE session SET side = 1 WHERE id = ?1", [&session.id])?;
        tx.commit()?;
        Ok(())
    }

    /// 任务开着的侧边聊天。
    pub fn task_side_sessions(&self, task_id: &str) -> StoreResult<Vec<TaskSession>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM session WHERE task_id = ?1 AND side = 1 ORDER BY created_at, id")?;
        let rows = stmt.query_map([task_id], session_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn side_sessions(&self) -> StoreResult<Vec<TaskSession>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM session WHERE side = 1 ORDER BY created_at, id")?;
        let rows = stmt.query_map([], session_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn is_side_session(&self, id: &str) -> StoreResult<bool> {
        Ok(self
            .conn()
            .query_row("SELECT side FROM session WHERE id = ?1", [id], |row| row.get(0))
            .optional()?
            .unwrap_or(false))
    }

    /// 删掉会话和它的时间线。
    pub fn remove_session(&self, id: &str) -> StoreResult<bool> {
        Ok(self.conn().execute("DELETE FROM session WHERE id = ?1", [id])? > 0)
    }

    pub fn session(&self, id: &str) -> StoreResult<Option<TaskSession>> {
        Ok(self
            .conn()
            .query_row("SELECT * FROM session WHERE id = ?1", [id], session_from_row)
            .optional()?)
    }

    pub fn set_session_native_id(&self, id: &str, native_id: &str) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE session SET native_id = ?2 WHERE id = ?1",
            params![id, native_id],
        )?;
        Ok(())
    }

    /// 还没说过话的会话直接换 Agent。
    pub fn set_session_agent(&self, id: &str, agent: AgentKind, options: &SessionOptions) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE session SET agent = ?2, options = ?3, native_id = NULL WHERE id = ?1",
            params![id, enum_text(&agent), to_text(options)],
        )?;
        Ok(())
    }

    pub fn set_session_options(&self, id: &str, options: &SessionOptions) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE session SET options = ?2 WHERE id = ?1",
            params![id, to_text(options)],
        )?;
        Ok(())
    }

    /// 写入（或覆盖）一条事件。状态事件同时改会话状态；对话内容同时刷新任务的更新时间；
    /// 给了 `attention` 就在同一个事务里改注意力投影。
    pub fn put_event(
        &self,
        task_id: &str,
        stored: &StoredEvent,
        activity: bool,
        attention: Option<&Attention>,
    ) -> StoreResult<()> {
        let event = &stored.event;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO event (session_id, seq, rev, id, ts, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id, seq) DO UPDATE SET rev = excluded.rev, ts = excluded.ts, body = excluded.body",
            params![
                event.session_id,
                event.seq as i64,
                stored.rev as i64,
                event.id,
                event.ts,
                to_text(&event.body)
            ],
        )?;
        if let SessionEventBody::StatusChanged { status } = &event.body {
            tx.execute(
                "UPDATE session SET status = ?2, updated_at = ?3 WHERE id = ?1",
                params![event.session_id, enum_text(status), event.ts],
            )?;
        }
        if activity {
            tx.execute(
                "UPDATE task SET updated_at = MAX(updated_at, ?2) WHERE id = ?1",
                params![task_id, event.ts],
            )?;
        }
        if let Some(attention) = attention {
            put_attention(&tx, &event.session_id, attention)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// `rev` 大于 `after` 的事件，按 seq 排列。`after` 为 0 时就是整条时间线。
    pub fn events_since(&self, session_id: &str, after: u64) -> StoreResult<Vec<StoredEvent>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM event WHERE session_id = ?1 AND rev > ?2 ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![session_id, after as i64], event_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// 会话和它的注意力行一起建。
fn insert_session(conn: &rusqlite::Connection, session: &TaskSession) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO session (id, task_id, agent, native_id, status, options, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            session.id,
            session.task_id,
            enum_text(&session.agent),
            session.native_id,
            enum_text(&session.status),
            to_text(&session.options),
            session.created_at,
            session.updated_at
        ],
    )?;
    put_attention(
        conn,
        &session.id,
        &Attention::from_status(session.status, session.updated_at),
    )
}

#[cfg(test)]
mod tests {
    use aiwb_core::Project;

    use super::*;

    fn store_with_project() -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .insert_project(&Project {
                id: "p".into(),
                name: "p".into(),
                path: "/p".into(),
                folders: vec!["/p".into()],
                pinned: false,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        store
    }

    fn task(id: &str, updated_at: i64) -> (Task, TaskSession) {
        let task = Task {
            id: id.into(),
            project_id: Some("p".into()),
            title: "修登录".into(),
            workspace: TaskWorkspace::Worktree {
                path: "/wt".into(),
                branch: Some("aiwb/x".into()),
                base_ref: Some("main".into()),
                base_sha: "abc".into(),
                shelved: None,
                local: None,
            },
            pinned: false,
            archived_at: None,
            created_at: 1,
            updated_at,
            parent_task_id: None,
        };
        let session = TaskSession {
            id: format!("{id}-s"),
            task_id: id.into(),
            agent: AgentKind::CodexCli,
            native_id: None,
            status: SessionStatus::Running,
            options: SessionOptions {
                model: Some("gpt".into()),
                ..Default::default()
            },
            created_at: 1,
            updated_at: 1,
        };
        (task, session)
    }

    fn stored(seq: u64, rev: u64, body: SessionEventBody) -> StoredEvent {
        StoredEvent {
            event: SessionEvent {
                id: format!("e{seq}"),
                session_id: "t1-s".into(),
                seq,
                ts: 10 + rev as i64,
                body,
            },
            rev,
        }
    }

    #[test]
    fn tasks_and_sessions_round_trip() {
        let store = store_with_project();
        let (a, sa) = task("t1", 5);
        let (b, sb) = task("t2", 9);
        store.insert_task(&a, &sa).unwrap();
        store.insert_task(&b, &sb).unwrap();
        let listed = store.list_tasks().unwrap();
        assert_eq!(listed.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t2", "t1"]);
        assert_eq!(listed[1], a);
        assert_eq!(store.session("t1-s").unwrap().unwrap(), sa);

        store.set_session_native_id("t1-s", "thread-1").unwrap();
        assert_eq!(store.session("t1-s").unwrap().unwrap().native_id.as_deref(), Some("thread-1"));

        let entries = store.task_entries().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].sessions, vec![sb]);

        // 删项目连带删任务和会话。
        store.remove_project("p").unwrap();
        assert!(store.list_tasks().unwrap().is_empty());
        assert!(store.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn standalone_task_has_no_project_and_survives_project_removal() {
        let store = store_with_project();
        let (mut a, sa) = task("t1", 5);
        a.project_id = None;
        a.workspace = TaskWorkspace::Folder { path: "/chats/2026-10-26/hi".into() };
        store.insert_task(&a, &sa).unwrap();
        assert!(store.set_task_pinned("t1", true).unwrap());
        store.remove_project("p").unwrap();
        let listed = store.task("t1").unwrap().unwrap();
        assert_eq!(listed.project_id, None);
        assert!(listed.pinned);
        assert_eq!(listed.workspace, a.workspace);
    }

    #[test]
    fn events_overwrite_by_seq_and_catch_up_by_rev() {
        let store = store_with_project();
        let (a, sa) = task("t1", 5);
        store.insert_task(&a, &sa).unwrap();
        let text = |t: &str| SessionEventBody::System { text: t.into() };
        store.put_event("t1", &stored(1, 1, text("一")), true, None).unwrap();
        store.put_event("t1", &stored(2, 2, text("二")), false, None).unwrap();
        store.put_event("t1", &stored(1, 3, text("一改")), false, None).unwrap();

        let all = store.events_since("t1-s", 0).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].event.seq, 1);
        assert_eq!(all[0].rev, 3);
        let after = store.events_since("t1-s", 2).unwrap();
        assert_eq!(after.len(), 1);
        assert!(matches!(&after[0].event.body, SessionEventBody::System { text } if text == "一改"));
        assert_eq!(store.task("t1").unwrap().unwrap().updated_at, 11);

        let status = SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        };
        store.put_event("t1", &stored(3, 4, status), false, None).unwrap();
        assert_eq!(store.session("t1-s").unwrap().unwrap().status, SessionStatus::Completed);
    }

    #[test]
    fn attention_follows_events_and_clears_when_read() {
        use aiwb_core::attention::AttentionState;
        let store = store_with_project();
        let (a, sa) = task("t1", 5);
        store.insert_task(&a, &sa).unwrap();
        // 新会话按状态带一行，没有未读。
        let first = store.attention("t1-s").unwrap().unwrap();
        assert_eq!(first.state, AttentionState::Working);
        assert!(!first.unread);

        let done = Attention {
            state: AttentionState::Done,
            unread: true,
            ask: None,
            preview: Some("好了".into()),
            updated_at: 20,
        };
        let status = SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        };
        store.put_event("t1", &stored(1, 1, status), false, Some(&done)).unwrap();
        assert_eq!(store.attention("t1-s").unwrap().unwrap(), done);
        assert_eq!(store.task_entries().unwrap()[0].attention, done);

        assert!(store.mark_read("t1-s").unwrap());
        assert!(!store.mark_read("t1-s").unwrap());
        assert!(!store.attention("t1-s").unwrap().unwrap().unread);

        store.remove_task("t1").unwrap();
        assert!(store.attention("t1-s").unwrap().is_none());
    }

    #[test]
    fn side_session_hangs_off_the_task_without_becoming_a_segment() {
        let store = store_with_project();
        let (a, sa) = task("t1", 5);
        store.insert_task(&a, &sa).unwrap();
        let side = TaskSession {
            id: "t1-side".into(),
            created_at: 7,
            ..sa.clone()
        };
        store.add_side_session(&side).unwrap();
        let second = TaskSession { id: "t1-side2".into(), ..side.clone() };
        store.add_side_session(&second).unwrap();

        assert_eq!(store.task_sessions("t1").unwrap(), vec![sa.clone()]);
        assert_eq!(store.list_sessions().unwrap(), vec![sa.clone()]);
        assert_eq!(store.task_side_sessions("t1").unwrap(), vec![side.clone(), second.clone()]);
        assert!(store.is_side_session("t1-side").unwrap());
        assert!(!store.is_side_session("t1-s").unwrap());
        let entry = &store.task_entries().unwrap()[0];
        assert_eq!(entry.sessions, vec![sa]);
        assert_eq!(entry.sides, vec![side, second.clone()]);

        store.remove_session("t1-side").unwrap();
        assert_eq!(store.task_entries().unwrap()[0].sides, vec![second]);
    }
}
