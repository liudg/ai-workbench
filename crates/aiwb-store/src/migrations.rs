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
    // 3：项目置顶、去掉项目默认 Agent；独立聊天的任务不属于项目；作曲栏草稿。
    // 改 project_id 可空要重建任务表，外键在迁移期间是关着的，删旧表不会连带删会话。
    "ALTER TABLE project ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE project DROP COLUMN default_agent;
    CREATE TABLE task_new (
        id          TEXT PRIMARY KEY,
        project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        workspace   TEXT NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    INSERT INTO task_new SELECT id, project_id, title, workspace, pinned, archived_at, created_at, updated_at FROM task;
    DROP TABLE task;
    ALTER TABLE task_new RENAME TO task;
    CREATE INDEX task_project ON task(project_id);
    CREATE TABLE draft (
        key        TEXT PRIMARY KEY,
        body       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );",
    // 4：注意力投影，每个会话一行。已有会话按状态补上，都当作看过了。
    "CREATE TABLE attention (
        session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
        state      TEXT NOT NULL,
        unread     INTEGER NOT NULL DEFAULT 0,
        ask        TEXT,
        preview    TEXT,
        updated_at INTEGER NOT NULL
    );
    INSERT INTO attention (session_id, state, updated_at)
    SELECT id,
        CASE status
            WHEN 'running' THEN 'working'
            WHEN 'completed' THEN 'done'
            WHEN 'stopped' THEN 'idle'
            ELSE status
        END,
        updated_at
    FROM session;",
    // 5：侧边聊天。挂在任务下，不算任务的会话段。
    "ALTER TABLE session ADD COLUMN side INTEGER NOT NULL DEFAULT 0;",
    // 6：子任务挂在开出它的任务下。父任务删掉后子任务留着，成为普通任务。
    "ALTER TABLE task ADD COLUMN parent_task_id TEXT REFERENCES task(id) ON DELETE SET NULL;",
];

/// 调用时外键必须是关着的：重建表的迁移要先删旧表。
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
