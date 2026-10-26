//! 按 `user_version` 逐个执行迁移。只能往末尾追加，已发布的迁移不改。

use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    // 1：元数据和项目
    "CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE project (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        folders       TEXT NOT NULL,
        default_agent TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );",
    // 2：任务、会话、事件。事件按 (session_id, seq) 排列；rev 每写一次换新，断线后按 rev 补。
    "CREATE TABLE task (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        workspace   TEXT NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE INDEX task_project ON task(project_id);
    CREATE TABLE session (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
        agent      TEXT NOT NULL,
        native_id  TEXT,
        status     TEXT NOT NULL,
        options    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX session_task ON session(task_id);
    CREATE TABLE event (
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        rev        INTEGER NOT NULL,
        id         TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        body       TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX event_rev ON event(session_id, rev);",
];

pub(crate) fn run(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: usize = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index + 1)?;
        tx.commit()?;
    }
    Ok(())
}
