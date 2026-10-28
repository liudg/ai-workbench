//! 注意力投影表。状态变化跟着事件一起写（见 `put_event`），看过一眼清未读。

use aiwb_core::attention::{AskKind, Attention, AttentionState};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::tasks::{enum_text, from_enum};
use crate::{Store, StoreResult};

pub(crate) fn attention_from_row(row: &Row<'_>) -> rusqlite::Result<Attention> {
    let state: String = row.get("state")?;
    let ask: Option<String> = row.get("ask")?;
    Ok(Attention {
        state: from_enum::<AttentionState>("state", &state)?,
        unread: row.get("unread")?,
        ask: ask.map(|ask| from_enum::<AskKind>("ask", &ask)).transpose()?,
        preview: row.get("preview")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(crate) fn put_attention(conn: &Connection, session_id: &str, attention: &Attention) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO attention (session_id, state, unread, ask, preview, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, unread = excluded.unread,
             ask = excluded.ask, preview = excluded.preview, updated_at = excluded.updated_at",
        params![
            session_id,
            enum_text(&attention.state),
            attention.unread,
            attention.ask.as_ref().map(enum_text),
            attention.preview,
            attention.updated_at
        ],
    )?;
    Ok(())
}

impl Store {
    pub fn attention(&self, session_id: &str) -> StoreResult<Option<Attention>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT * FROM attention WHERE session_id = ?1",
                [session_id],
                attention_from_row,
            )
            .optional()?)
    }

    /// 全部会话的注意力，按会话 id。
    pub(crate) fn attention_rows(&self) -> StoreResult<Vec<(String, Attention)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM attention")?;
        let rows = stmt.query_map([], |row| Ok((row.get("session_id")?, attention_from_row(row)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn set_attention(&self, session_id: &str, attention: &Attention) -> StoreResult<()> {
        put_attention(&self.conn(), session_id, attention)
    }

    /// 看过了。原来就没有未读时返回 false。
    pub fn mark_read(&self, session_id: &str) -> StoreResult<bool> {
        Ok(self.conn().execute(
            "UPDATE attention SET unread = 0 WHERE session_id = ?1 AND unread = 1",
            [session_id],
        )? > 0)
    }
}
