//! SQLite 存储，工作台的唯一数据源。连接用一把锁串行化；调用方不要在持锁期间等待别的东西。

mod attention;
mod drafts;
mod legacy;
mod migrations;
mod projects;
mod tasks;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension};

pub use legacy::import_legacy_projects;

/// 数据库文件名，放在数据目录下。
pub const DB_FILE: &str = "workbench.sqlite";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("数据库出错：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> StoreResult<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> StoreResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        migrations::run(&mut conn)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn meta(&self, key: &str) -> StoreResult<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 第 2 版的库升上来，任务和会话都还在，项目默认 Agent 没了。
    #[test]
    fn upgrades_version_two_without_losing_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, folders TEXT NOT NULL,
                    default_agent TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE task (id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
                    title TEXT NOT NULL, workspace TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
                    archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE INDEX task_project ON task(project_id);
                CREATE TABLE session (id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
                    agent TEXT NOT NULL, native_id TEXT, status TEXT NOT NULL, options TEXT NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE event (session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL, rev INTEGER NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL,
                    body TEXT NOT NULL, PRIMARY KEY (session_id, seq));
                INSERT INTO project VALUES ('p', 'P', '[\"/p\"]', 'codex-cli', 1, 1);
                INSERT INTO task VALUES ('t', 'p', '标题', '{\"kind\":\"root\"}', 0, NULL, 1, 1);
                INSERT INTO session VALUES ('s', 't', 'codex-cli', NULL, 'completed', '{}', 1, 1);
                PRAGMA user_version = 2;",
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.list_projects().unwrap()[0].path, "/p");
        assert_eq!(store.task("t").unwrap().unwrap().project_id.as_deref(), Some("p"));
        assert!(store.session("s").unwrap().is_some());
        // 已有会话补上注意力行，按状态，没有未读。
        let attention = store.attention("s").unwrap().unwrap();
        assert_eq!(attention.state, aiwb_core::attention::AttentionState::Done);
        assert!(!attention.unread);
        // 外键重新打开了：删项目连带删任务和会话。
        store.remove_project("p").unwrap();
        assert!(store.session("s").unwrap().is_none());
    }
}
