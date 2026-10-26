//! 作曲栏草稿。内容由界面决定，这里只按键存一份 JSON。

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::{Store, StoreResult};

impl Store {
    pub fn draft(&self, key: &str) -> StoreResult<Option<Value>> {
        let raw: Option<String> = self
            .conn()
            .query_row("SELECT body FROM draft WHERE key = ?1", [key], |row| row.get(0))
            .optional()?;
        Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    /// `None` 删掉这份草稿。
    pub fn set_draft(&self, key: &str, body: Option<&Value>, now: i64) -> StoreResult<()> {
        match body {
            Some(body) => self.conn().execute(
                "INSERT INTO draft (key, body, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
                params![key, body.to_string(), now],
            )?,
            None => self.conn().execute("DELETE FROM draft WHERE key = ?1", [key])?,
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn set_read_and_clear() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.draft("s1").unwrap(), None);
        store.set_draft("s1", Some(&json!({ "text": "一" })), 1).unwrap();
        store.set_draft("s1", Some(&json!({ "text": "二" })), 2).unwrap();
        assert_eq!(store.draft("s1").unwrap(), Some(json!({ "text": "二" })));
        store.set_draft("s1", None, 3).unwrap();
        assert_eq!(store.draft("s1").unwrap(), None);
    }
}
