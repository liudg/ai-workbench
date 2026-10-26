//! 任务、会话和事件日志。

use aiwb_core::models::{AgentKind, SessionEvent, SessionEventBody, SessionStatus};
use aiwb_core::task::{SessionOptions, StoredEvent, Task, TaskEntry, TaskSession, TaskWorkspace};
use rusqlite::{params, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{Store, StoreError, StoreResult};

fn to_text<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("serialize column")
}

/// 枚举存成不带引号的字符串，查询时好读。
fn enum_text<T: Serialize>(value: &T) -> String {
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

fn from_enum<T: DeserializeOwned>(column: &str, raw: &str) -> rusqlite::Result<T> {
    from_text(column, &serde_json::Value::String(raw.to_string()).to_string())
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let workspace: String = row.get("workspace")?;
    Ok(Task {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        workspace: from_text::<TaskWorkspace>("workspace", &workspace)?,
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
        if session.task_id != task.id {
            return Err(StoreError::Invalid("会话不属于这个任务".into()));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO task (id, project_id, title, workspace, pinned, archived_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                task.id,
                task.project_id,
                task.title,
                to_text(&task.workspace),
                task.pinned,
                task.archived_at,
                task.created_at,
                task.updated_at
            ],
        )?;
        insert_session(&tx, session)?;
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

    /// 任务列表主题的内容：每个任务带上它的会话。
    pub fn task_entries(&self) -> StoreResult<Vec<TaskEntry>> {
        let mut sessions = self.list_sessions()?;
        Ok(self
            .list_tasks()?
            .into_iter()
            .map(|task| {
                let (mine, rest): (Vec<_>, Vec<_>) =
                    sessions.drain(..).partition(|session| session.task_id == task.id);
                sessions = rest;
                TaskEntry {
                    task,
                    sessions: mine,
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

    pub fn set_task_archived(&self, id: &str, archived_at: Option<i64>, now: i64) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE task SET archived_at = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, archived_at, now],
        )? > 0)
    }

    pub fn remove_task(&self, id: &str) -> StoreResult<bool> {
        Ok(self.conn().execute("DELETE FROM task WHERE id = ?1", [id])? > 0)
    }

    pub fn list_sessions(&self) -> StoreResult<Vec<TaskSession>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM session ORDER BY created_at, id")?;
        let rows = stmt.query_map([], session_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
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

    pub fn set_session_options(&self, id: &str, options: &SessionOptions) -> StoreResult<()> {
        self.conn().execute(
            "UPDATE session SET options = ?2 WHERE id = ?1",
            params![id, to_text(options)],
        )?;
        Ok(())
    }

    /// 写入（或覆盖）一条事件。状态事件同时改会话状态；对话内容同时刷新任务的更新时间。
    pub fn put_event(&self, task_id: &str, stored: &StoredEvent, activity: bool) -> StoreResult<()> {
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
    Ok(())
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
                default_agent: "codex-cli".into(),
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        store
    }

    fn task(id: &str, updated_at: i64) -> (Task, TaskSession) {
        let task = Task {
            id: id.into(),
            project_id: "p".into(),
            title: "修登录".into(),
            workspace: TaskWorkspace::Worktree {
                path: "/wt".into(),
                branch: "aiwb/x".into(),
                base_ref: Some("main".into()),
                base_sha: "abc".into(),
            },
            pinned: false,
            archived_at: None,
            created_at: 1,
            updated_at,
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
    fn events_overwrite_by_seq_and_catch_up_by_rev() {
        let store = store_with_project();
        let (a, sa) = task("t1", 5);
        store.insert_task(&a, &sa).unwrap();
        let text = |t: &str| SessionEventBody::System { text: t.into() };
        store.put_event("t1", &stored(1, 1, text("一")), true).unwrap();
        store.put_event("t1", &stored(2, 2, text("二")), false).unwrap();
        store.put_event("t1", &stored(1, 3, text("一改")), false).unwrap();

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
        store.put_event("t1", &stored(3, 4, status), false).unwrap();
        assert_eq!(store.session("t1-s").unwrap().unwrap().status, SessionStatus::Completed);
    }
}
