//! 逐轮检查点（`checkpoint` 表）的增删查与按轮清理。

use aiwb_core::checkpoint::TurnCheckpoint;
use rusqlite::{params, OptionalExtension, Row};

use crate::{Store, StoreResult};

pub(crate) fn checkpoint_from_row(row: &Row<'_>) -> rusqlite::Result<TurnCheckpoint> {
    let cut_seq: i64 = row.get("cut_seq")?;
    Ok(TurnCheckpoint {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        session_id: row.get("session_id")?,
        user_event_id: row.get("user_event_id")?,
        cut_seq: cut_seq as u64,
        turn_id: row.get("turn_id")?,
        pre_ref: row.get("pre_ref")?,
        post_ref: row.get("post_ref")?,
        head_oid: row.get("head_oid")?,
        branch: row.get("branch")?,
        cwd: row.get("cwd")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl Store {
    pub fn put_checkpoint(&self, cp: &TurnCheckpoint) -> StoreResult<()> {
        self.conn().execute(
            "INSERT INTO checkpoint (
                id, task_id, session_id, user_event_id, cut_seq, turn_id,
                pre_ref, post_ref, head_oid, branch, cwd, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                cut_seq = excluded.cut_seq,
                turn_id = COALESCE(excluded.turn_id, checkpoint.turn_id),
                pre_ref = COALESCE(excluded.pre_ref, checkpoint.pre_ref),
                post_ref = COALESCE(excluded.post_ref, checkpoint.post_ref),
                head_oid = COALESCE(excluded.head_oid, checkpoint.head_oid),
                branch = COALESCE(excluded.branch, checkpoint.branch),
                updated_at = excluded.updated_at",
            params![
                cp.id,
                cp.task_id,
                cp.session_id,
                cp.user_event_id,
                cp.cut_seq as i64,
                cp.turn_id,
                cp.pre_ref,
                cp.post_ref,
                cp.head_oid,
                cp.branch,
                cp.cwd,
                cp.created_at,
                cp.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_checkpoint_post(
        &self,
        id: &str,
        post_ref: Option<&str>,
        now: i64,
    ) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE checkpoint
             SET post_ref = COALESCE(?2, post_ref),
                 updated_at = ?3
             WHERE id = ?1",
            params![id, post_ref, now],
        )? > 0)
    }

    pub fn update_checkpoint_turn_id(&self, id: &str, turn_id: &str, now: i64) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE checkpoint SET turn_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, turn_id, now],
        )? > 0)
    }

    pub fn task_checkpoints(&self, task_id: &str) -> StoreResult<Vec<TurnCheckpoint>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM checkpoint WHERE task_id = ?1 ORDER BY created_at ASC, cut_seq ASC",
        )?;
        let rows = stmt.query_map([task_id], checkpoint_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn session_checkpoints(&self, session_id: &str) -> StoreResult<Vec<TurnCheckpoint>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM checkpoint WHERE session_id = ?1 ORDER BY cut_seq ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([session_id], checkpoint_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn checkpoint_for_user_event(
        &self,
        session_id: &str,
        user_event_id: &str,
    ) -> StoreResult<Option<TurnCheckpoint>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT * FROM checkpoint WHERE session_id = ?1 AND user_event_id = ?2",
                params![session_id, user_event_id],
                checkpoint_from_row,
            )
            .optional()?)
    }

    /// 收集某个任务关联的全部隐藏 Git 引用，供删除任务前清理 `refs/aiwb/checkpoints/*`。
    pub fn task_checkpoint_refs(&self, task_id: &str) -> StoreResult<Vec<(String, String)>> {
        let checkpoints = self.task_checkpoints(task_id)?;
        let mut refs = Vec::new();
        for cp in checkpoints {
            if let Some(pre) = cp.pre_ref {
                refs.push((cp.cwd.clone(), pre));
            }
            if let Some(post) = cp.post_ref {
                refs.push((cp.cwd.clone(), post));
            }
        }
        Ok(refs)
    }
}
