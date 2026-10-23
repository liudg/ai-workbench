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
