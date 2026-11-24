//! 基于 SQLite FTS5 `trigram` 的跨项目会话标题与消息正文全文检索。
//!
//! 关键约束：SQLite `trigram` 分词器对 `< 3` 个 Unicode 字符的词元不产出三元组，
//! 因此中文双字词（如「登录」「报错」）或两位英文缩写（如 `db`、`ui`）走 `LIKE` 混合扫描，
//! `>= 3` 字符词元走 FTS5 字面短语索引加速，并在 Rust 层统一做大小写无关核验、加权排序与上下文摘要切片。

use std::collections::HashMap;

use aiwb_core::models::SessionEventBody;
use aiwb_core::search::{SearchTasksQuery, TaskSearchHit};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::{Store, StoreResult};

const SNIPPET_LEAD_CHARS: usize = 24;
const SNIPPET_MAX_CHARS: usize = 160;
const DEFAULT_RESULT_LIMIT: usize = 30;

pub(crate) fn upsert_title_doc(
    conn: &Connection,
    task_id: &str,
    title: &str,
) -> rusqlite::Result<()> {
    let key = format!("title:{task_id}");
    delete_doc_by_key(conn, &key)?;
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO search_fts (text, task_id, session_id, event_id, seq, role)
         VALUES (?1, ?2, '', '', 0, 'title')",
        params![trimmed, task_id],
    )?;
    let rowid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO search_doc (doc_key, fts_rowid, task_id, session_id, seq)
         VALUES (?1, ?2, ?3, NULL, NULL)",
        params![key, rowid, task_id],
    )?;
    Ok(())
}

pub(crate) fn indexable_event_text(body: &SessionEventBody) -> Option<(&'static str, &str)> {
    match body {
        SessionEventBody::UserMessage {
            text,
            sender: None,
            ..
        } => {
            let t = text.trim();
            (!t.is_empty()).then_some(("user", t))
        }
        SessionEventBody::AgentMessage {
            text,
            dedupe_of: None,
            ..
        } => {
            let t = text.trim();
            (!t.is_empty()).then_some(("assistant", t))
        }
        _ => None,
    }
}

pub(crate) fn upsert_event_doc(
    conn: &Connection,
    task_id: &str,
    session_id: &str,
    event_id: &str,
    seq: u64,
    body: &SessionEventBody,
) -> rusqlite::Result<()> {
    let key = format!("event:{session_id}:{seq}");
    let Some((role, text)) = indexable_event_text(body) else {
        return delete_doc_by_key(conn, &key);
    };
    let existing_text: Option<String> = conn
        .query_row(
            "SELECT f.text
             FROM search_doc d
             JOIN search_fts f ON f.rowid = d.fts_rowid
             WHERE d.doc_key = ?1",
            [&key],
            |row| row.get(0),
        )
        .optional()?;
    if existing_text.as_deref() == Some(text) {
        return Ok(());
    }
    delete_doc_by_key(conn, &key)?;
    conn.execute(
        "INSERT INTO search_fts (text, task_id, session_id, event_id, seq, role)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![text, task_id, session_id, event_id, seq as i64, role],
    )?;
    let rowid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO search_doc (doc_key, fts_rowid, task_id, session_id, seq)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![key, rowid, task_id, session_id, seq as i64],
    )?;
    Ok(())
}

pub(crate) fn mark_event_dirty(
    conn: &Connection,
    session_id: &str,
    seq: u64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO search_dirty (session_id, seq) VALUES (?1, ?2)",
        params![session_id, seq as i64],
    )?;
    Ok(())
}

pub(crate) fn clear_event_dirty(
    conn: &Connection,
    session_id: &str,
    seq: u64,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM search_dirty WHERE session_id = ?1 AND seq = ?2",
        params![session_id, seq as i64],
    )?;
    Ok(())
}

/// 回合收尾时仅补齐本轮在流式输出期间跳过索引的脏事件，不重扫历史旧消息。
pub(crate) fn sync_dirty_session_events(
    conn: &Connection,
    task_id: &str,
    session_id: &str,
) -> rusqlite::Result<()> {
    let rows: Vec<(String, i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT e.id, e.seq, e.body
             FROM search_dirty d
             JOIN event e ON e.session_id = d.session_id AND e.seq = d.seq
             WHERE d.session_id = ?1",
        )?;
        let mapped = stmt
            .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        mapped.collect::<Result<_, _>>()?
    };
    if rows.is_empty() {
        return Ok(());
    }
    for (event_id, seq, raw_body) in rows {
        if let Ok(body) = serde_json::from_str::<SessionEventBody>(&raw_body) {
            upsert_event_doc(conn, task_id, session_id, &event_id, seq as u64, &body)?;
        }
    }
    conn.execute("DELETE FROM search_dirty WHERE session_id = ?1", [session_id])?;
    Ok(())
}

fn delete_doc_by_key(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM search_doc WHERE doc_key = ?1", [key])?;
    Ok(())
}

/// 迁移第 7 版升级时回填已有任务标题与主对话消息。
pub(crate) fn backfill_tx(conn: &Connection) -> rusqlite::Result<()> {
    {
        let mut stmt = conn.prepare("SELECT id, title FROM task")?;
        let tasks: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (task_id, title) in tasks {
            upsert_title_doc(conn, &task_id, &title)?;
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT s.task_id, e.session_id, e.id, e.seq, e.body
             FROM event e
             JOIN session s ON s.id = e.session_id
             WHERE s.side = 0
               AND json_extract(e.body, '$.kind') IN ('user-message', 'agent-message')",
        )?;
        let rows: Vec<(String, String, String, i64, String)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        for (task_id, session_id, event_id, seq, raw_body) in rows {
            if let Ok(body) = serde_json::from_str::<SessionEventBody>(&raw_body) {
                upsert_event_doc(conn, &task_id, &session_id, &event_id, seq as u64, &body)?;
            }
        }
    }
    Ok(())
}

fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for ch in term.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

fn strip_inline_markup(s: &str) -> String {
    s.replace("**", "").replace('`', "")
}

/// 提取围绕首个命中词的紧凑单行摘要片段。
pub fn build_search_snippet(text: &str, terms_lower: &[String]) -> String {
    let stripped = strip_inline_markup(text);
    let collapsed: String = {
        let joined = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
        if joined.is_empty() {
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        } else {
            joined
        }
    };
    if collapsed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = collapsed.chars().collect();
    let mut lower_collapsed = String::with_capacity(collapsed.len());
    let mut byte_to_char_idx = Vec::with_capacity(collapsed.len());
    for (char_idx, ch) in chars.iter().copied().enumerate() {
        for lower_ch in ch.to_lowercase() {
            let prev_len = lower_collapsed.len();
            lower_collapsed.push(lower_ch);
            byte_to_char_idx.resize(lower_collapsed.len(), char_idx);
            debug_assert!(lower_collapsed.len() > prev_len);
        }
    }

    let match_char_idx = terms_lower
        .iter()
        .filter_map(|term| {
            let normalized = strip_inline_markup(term);
            let needle = if normalized.is_empty() {
                term.as_str()
            } else {
                normalized.as_str()
            };
            if needle.is_empty() {
                return None;
            }
            lower_collapsed
                .find(needle)
                .and_then(|byte_pos| byte_to_char_idx.get(byte_pos).copied())
        })
        .min()
        .unwrap_or(0)
        .min(chars.len());

    let start = match_char_idx.saturating_sub(SNIPPET_LEAD_CHARS).min(chars.len());
    let end = (start + SNIPPET_MAX_CHARS).min(chars.len());
    let slice: String = chars[start..end].iter().collect();
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < chars.len() { "…" } else { "" };
    format!("{prefix}{slice}{suffix}")
}

fn fts_phrase_clause(term: &str) -> String {
    let lower = term.to_lowercase();
    let esc_lower = lower.replace('"', "\"\"");
    if term.is_ascii() || term == lower {
        format!("\"{esc_lower}\"")
    } else {
        let esc_orig = term.replace('"', "\"\"");
        format!("(\"{esc_orig}\" OR \"{esc_lower}\")")
    }
}

fn append_short_term_likes(sql: &mut String, params_out: &mut Vec<SqlValue>, short_terms: &[&str]) {
    for term in short_terms {
        let idx = params_out.len() + 1;
        sql.push_str(&format!(
            " AND (f.text LIKE ?{} ESCAPE '\\' OR f.text LIKE ?{} ESCAPE '\\' OR f.text LIKE ?{} ESCAPE '\\')",
            idx,
            idx + 1,
            idx + 2,
        ));
        params_out.push(SqlValue::from(escape_like(term)));
        params_out.push(SqlValue::from(escape_like(&term.to_lowercase())));
        params_out.push(SqlValue::from(escape_like(&term.to_uppercase())));
    }
}

fn row_str<'a>(row: &'a rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<&'a str> {
    row.get_ref(idx)?.as_str().map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(err))
    })
}

impl Store {
    pub fn search_tasks(&self, req: &SearchTasksQuery) -> StoreResult<Vec<TaskSearchHit>> {
        let terms: Vec<&str> = req.query.split_whitespace().filter(|t| !t.is_empty()).collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let terms_lower: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();
        let (long_terms, short_terms): (Vec<&str>, Vec<&str>) =
            terms.iter().copied().partition(|t| t.chars().count() >= 3);
        let limit = req.limit.unwrap_or(DEFAULT_RESULT_LIMIT).clamp(1, 100);
        let include_archived = if req.include_archived { 1_i64 } else { 0_i64 };
        let project_param = match &req.project_id {
            Some(pid) => SqlValue::from(pid.clone()),
            None => SqlValue::Null,
        };

        let full_query_lower = terms_lower.join(" ");
        // 统一长词（FTS5 `MATCH` 粗筛）与纯短词（`LIKE` 粗筛）查询路径，不提前按时间截断候选行，
        // 逐行流式聚合每任务的最高分命中，避免较新的低分消息淘汰较早的高分（如前缀匹配）消息。
        let mut sql_params: Vec<SqlValue> = vec![project_param, SqlValue::from(include_archived)];
        let mut sql = String::from(
            "SELECT
                t.id,
                t.project_id,
                t.title,
                t.archived_at,
                t.updated_at,
                f.session_id,
                f.event_id,
                f.seq,
                f.role,
                f.text,
                f.rowid,
                e.ts
             FROM search_fts f
             JOIN task t ON t.id = f.task_id
             LEFT JOIN event e ON f.role != 'title' AND e.session_id = f.session_id AND e.seq = f.seq
             WHERE (?1 IS NULL OR t.project_id = ?1)
               AND (?2 = 1 OR t.archived_at IS NULL)",
        );
        if !long_terms.is_empty() {
            let fts_match = long_terms
                .iter()
                .map(|t| fts_phrase_clause(t))
                .collect::<Vec<_>>()
                .join(" AND ");
            let idx = sql_params.len() + 1;
            sql.push_str(&format!(" AND search_fts MATCH ?{idx}"));
            sql_params.push(SqlValue::from(fts_match));
        }
        append_short_term_likes(&mut sql, &mut sql_params, &short_terms);

        // 每个任务聚合挑出最值得展示的一条命中（同时标题命中会给该任务加分，优先保留可定位跳转的正文命中）。
        struct TaskAggregate {
            task_id: String,
            project_id: Option<String>,
            task_title: String,
            archived_at: Option<i64>,
            updated_at: i64,
            best_session_id: Option<String>,
            best_event_id: Option<String>,
            best_seq: Option<u64>,
            best_role: String,
            best_text: String,
            best_ts: i64,
            best_fts_rowid: i64,
            best_hit_score: i64,
            best_row_score: i64,
            title_bonus: i64,
        }

        let mut per_task: HashMap<String, TaskAggregate> = HashMap::new();
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(sql_params))?;

        while let Some(row) = rows.next()? {
            let text = row_str(row, 9)?;
            let text_lower = text.to_lowercase();
            if !terms_lower.iter().all(|term| text_lower.contains(term.as_str())) {
                continue;
            }

            let task_id = row_str(row, 0)?;
            let task_updated_at: i64 = row.get(4)?;
            let role = row_str(row, 8)?;
            let fts_rowid: i64 = row.get(10)?;
            let event_ts: Option<i64> = row.get(11)?;

            let is_title = role == "title";
            let exact_phrase = text_lower.contains(&full_query_lower);
            let starts_with = text_lower.starts_with(&full_query_lower);
            let mut row_score: i64 = if is_title { 80 } else { 100 };
            if exact_phrase {
                row_score += 50;
            }
            if starts_with {
                row_score += 30;
            }
            if role == "user" {
                row_score += 10;
            }

            let ts = event_ts.unwrap_or(task_updated_at);

            if let Some(entry) = per_task.get_mut(task_id) {
                if is_title {
                    entry.title_bonus = entry.title_bonus.max(90);
                }
                entry.best_row_score = entry.best_row_score.max(row_score);
                // 正文命中比纯标题命中更能展示上下文并支持直跳对应消息：始终允许正文命中替换纯标题项，且不让纯标题项反盖正文项。
                let current_is_title = entry.best_role == "title";
                let should_replace = if !is_title && current_is_title {
                    true
                } else if is_title && !current_is_title {
                    false
                } else {
                    (row_score, ts, fts_rowid)
                        > (entry.best_hit_score, entry.best_ts, entry.best_fts_rowid)
                };
                if should_replace {
                    let session_id = row_str(row, 5)?;
                    let event_id = row_str(row, 6)?;
                    let seq: i64 = row.get(7)?;
                    entry.best_session_id =
                        (!is_title && !session_id.is_empty()).then(|| session_id.to_string());
                    entry.best_event_id =
                        (!is_title && !event_id.is_empty()).then(|| event_id.to_string());
                    entry.best_seq = (!is_title && seq > 0).then_some(seq as u64);
                    entry.best_role = role.to_string();
                    entry.best_text = text.to_string();
                    entry.best_ts = ts;
                    entry.best_fts_rowid = fts_rowid;
                    entry.best_hit_score = row_score;
                }
            } else {
                let session_id = row_str(row, 5)?;
                let event_id = row_str(row, 6)?;
                let seq: i64 = row.get(7)?;
                per_task.insert(
                    task_id.to_string(),
                    TaskAggregate {
                        task_id: task_id.to_string(),
                        project_id: row.get(1)?,
                        task_title: row.get(2)?,
                        archived_at: row.get(3)?,
                        updated_at: task_updated_at,
                        best_session_id: (!is_title && !session_id.is_empty())
                            .then(|| session_id.to_string()),
                        best_event_id: (!is_title && !event_id.is_empty())
                            .then(|| event_id.to_string()),
                        best_seq: (!is_title && seq > 0).then_some(seq as u64),
                        best_role: role.to_string(),
                        best_text: text.to_string(),
                        best_ts: ts,
                        best_fts_rowid: fts_rowid,
                        best_hit_score: row_score,
                        best_row_score: row_score,
                        title_bonus: if is_title { 90 } else { 0 },
                    },
                );
            }
        }

        let mut ranked: Vec<TaskAggregate> = per_task.into_values().collect();
        ranked.sort_by(|a, b| {
            a.archived_at
                .is_some()
                .cmp(&b.archived_at.is_some())
                .then_with(|| {
                    (b.best_row_score + b.title_bonus).cmp(&(a.best_row_score + a.title_bonus))
                })
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.task_id.cmp(&b.task_id))
        });

        Ok(ranked
            .into_iter()
            .take(limit)
            .map(|agg| TaskSearchHit {
                task_id: agg.task_id,
                project_id: agg.project_id,
                task_title: agg.task_title,
                archived_at: agg.archived_at,
                session_id: agg.best_session_id,
                event_id: agg.best_event_id,
                seq: agg.best_seq,
                role: agg.best_role,
                snippet: build_search_snippet(&agg.best_text, &terms_lower),
                ts: agg.best_ts,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::models::{AgentKind, SessionEvent, SessionStatus};
    use aiwb_core::task::{SessionOptions, StoredEvent, Task, TaskSession, TaskWorkspace};

    #[test]
    fn build_search_snippet_handles_unicode_lowercase_expansion_and_inline_markup() {
        // 50 个 'İ' 小写展开为 100 个字符（'i' + '\u{307}'），旧实现按展开后字符下标切片 collapsed 会越界 panic。
        let prefix: String = std::iter::repeat('İ').take(50).collect();
        let text = format!("{prefix} target_hit");
        let snippet = build_search_snippet(&text, &[String::from("target_hit")]);
        assert!(snippet.contains("target_hit"));

        // 末尾直接命中展开字符也不越界。
        let only_dotted = format!("{} target", std::iter::repeat('İ').take(30).collect::<String>());
        let s2 = build_search_snippet(&only_dotted, &[String::from("target")]);
        assert!(s2.ends_with("target"));

        // 带反引号与粗体星号的查询词也能定位到剥掉标记后的正文位置。
        let padded = format!(
            "{} 调用 `fetch_user_token` 失败并抛出 **AuthError**",
            "前置上下文填充 ".repeat(10)
        );
        let s3 = build_search_snippet(&padded, &[String::from("`fetch_user_token`")]);
        assert!(s3.contains("fetch_user_token"));
        assert!(s3.starts_with('…'));
    }

    #[test]
    fn search_tasks_handles_mixed_long_and_short_terms_and_streaming_flush() {
        let store = Store::open_in_memory().unwrap();
        let mk_task = |id: &str, title: &str, ts: i64| {
            let task = Task {
                id: id.into(),
                project_id: None,
                title: title.into(),
                workspace: TaskWorkspace::Root,
                parent_task_id: None,
                pinned: false,
                archived_at: None,
                created_at: ts,
                updated_at: ts,
            };
            let sess = TaskSession {
                id: format!("{id}-s"),
                task_id: id.into(),
                agent: AgentKind::ClaudeCode,
                instance_id: None,
                native_id: None,
                status: SessionStatus::Running,
                options: SessionOptions::default(),
                created_at: ts,
                updated_at: ts,
            };
            store.insert_task(&task, &sess).unwrap();
        };

        mk_task("t-old", "React 列表页", 10);
        store
            .put_event(
                "t-old",
                &StoredEvent {
                    event: SessionEvent {
                        id: "e-old".into(),
                        session_id: "t-old-s".into(),
                        seq: 1,
                        ts: 11,
                        body: SessionEventBody::UserMessage {
                            text: "优化 React 表格渲染性能".into(),
                            images: vec![],
                            annotations: 0,
                            sender: None,
                        },
                    },
                    rev: 1,
                },
                true,
                None,
            )
            .unwrap();

        mk_task("t-mix", "控制台排障", 20);
        // 流式增量：第 1 次写入初始文本，第 2 次覆盖追加关键命中词，随后由 StatusChanged(Completed) 刷入 FTS。
        store
            .put_event(
                "t-mix",
                &StoredEvent {
                    event: SessionEvent {
                        id: "e-stream".into(),
                        session_id: "t-mix-s".into(),
                        seq: 1,
                        ts: 21,
                        body: SessionEventBody::AgentMessage {
                            text: "正在分析...".into(),
                            phase: None,
                            mode: None,
                            stream_id: Some("stream-1".into()),
                            dedupe_of: None,
                        },
                    },
                    rev: 1,
                },
                true,
                None,
            )
            .unwrap();
        store
            .put_event(
                "t-mix",
                &StoredEvent {
                    event: SessionEvent {
                        id: "e-stream".into(),
                        session_id: "t-mix-s".into(),
                        seq: 1,
                        ts: 22,
                        body: SessionEventBody::AgentMessage {
                            text: "正在分析 React 登录 态失效原因".into(),
                            phase: None,
                            mode: None,
                            stream_id: Some("stream-1".into()),
                            dedupe_of: None,
                        },
                    },
                    rev: 2,
                },
                true,
                None,
            )
            .unwrap();
        store
            .put_event(
                "t-mix",
                &StoredEvent {
                    event: SessionEvent {
                        id: "e-done".into(),
                        session_id: "t-mix-s".into(),
                        seq: 2,
                        ts: 23,
                        body: SessionEventBody::StatusChanged {
                            status: SessionStatus::Completed,
                        },
                    },
                    rev: 3,
                },
                true,
                None,
            )
            .unwrap();

        let hits = store
            .search_tasks(&SearchTasksQuery {
                query: "REACT 登录".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].task_id, "t-mix");
    }

    #[test]
    fn search_tasks_prefers_body_hit_over_title_only_hit_while_preserving_title_bonus() {
        let store = Store::open_in_memory().unwrap();
        let mk_task = |id: &str, title: &str, ts: i64| {
            let task = Task {
                id: id.into(),
                project_id: None,
                title: title.into(),
                workspace: TaskWorkspace::Root,
                parent_task_id: None,
                pinned: false,
                archived_at: None,
                created_at: ts,
                updated_at: ts,
            };
            let sess = TaskSession {
                id: format!("{id}-s"),
                task_id: id.into(),
                agent: AgentKind::ClaudeCode,
                instance_id: None,
                native_id: None,
                status: SessionStatus::Completed,
                options: SessionOptions::default(),
                created_at: ts,
                updated_at: ts,
            };
            store.insert_task(&task, &sess).unwrap();
        };

        // 任务 1：标题以查询短语开头（title row_score = 80+50+30 = 160），正文为拆分词元匹配（assistant row_score = 100）。
        mk_task("t-both", "互斥锁重入 死锁排查", 10);
        store
            .put_event(
                "t-both",
                &StoredEvent {
                    event: SessionEvent {
                        id: "ev-body".into(),
                        session_id: "t-both-s".into(),
                        seq: 1,
                        ts: 11,
                        body: SessionEventBody::AgentMessage {
                            text: "定位到 互斥锁重入 导致了后台线程 死锁排查 日志阻塞".into(),
                            phase: None,
                            mode: None,
                            stream_id: None,
                            dedupe_of: None,
                        },
                    },
                    rev: 1,
                },
                true,
                None,
            )
            .unwrap();

        // 任务 2：只有正文命中（无标题加分），时间戳更新。
        mk_task("t-body-only", "其它问题", 30);
        store
            .put_event(
                "t-body-only",
                &StoredEvent {
                    event: SessionEvent {
                        id: "ev-other".into(),
                        session_id: "t-body-only-s".into(),
                        seq: 1,
                        ts: 31,
                        body: SessionEventBody::UserMessage {
                            text: "互斥锁重入 死锁排查".into(),
                            images: vec![],
                            annotations: 0,
                            sender: None,
                        },
                    },
                    rev: 1,
                },
                true,
                None,
            )
            .unwrap();

        let hits = store
            .search_tasks(&SearchTasksQuery {
                query: "互斥锁重入 死锁排查".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 2);
        // 标题加分使 t-both 排在第一位，同时展示项必须是可定位跳转的正文命中而非纯标题项。
        assert_eq!(hits[0].task_id, "t-both");
        assert_ne!(hits[0].role, "title");
        assert_eq!(hits[0].session_id.as_deref(), Some("t-both-s"));
        assert_eq!(hits[0].event_id.as_deref(), Some("ev-body"));
    }

    #[test]
    fn search_tasks_handles_non_ascii_uppercase_multi_term_queries() {
        let store = Store::open_in_memory().unwrap();
        let task = Task {
            id: "t-accent".into(),
            project_id: None,
            title: "École portal".into(),
            workspace: TaskWorkspace::Root,
            parent_task_id: None,
            pinned: false,
            archived_at: None,
            created_at: 10,
            updated_at: 10,
        };
        let sess = TaskSession {
            id: "t-accent-s".into(),
            task_id: "t-accent".into(),
            agent: AgentKind::ClaudeCode,
            instance_id: None,
            native_id: None,
            status: SessionStatus::Completed,
            options: SessionOptions::default(),
            created_at: 10,
            updated_at: 10,
        };
        store.insert_task(&task, &sess).unwrap();
        store
            .put_event(
                "t-accent",
                &StoredEvent {
                    event: SessionEvent {
                        id: "e-accent".into(),
                        session_id: "t-accent-s".into(),
                        seq: 1,
                        ts: 11,
                        body: SessionEventBody::UserMessage {
                            text: "Fix école login flow for Über users".into(),
                            images: vec![],
                            annotations: 0,
                            sender: None,
                        },
                    },
                    rev: 1,
                },
                true,
                None,
            )
            .unwrap();

        for query in ["École login", "login École", "École Über"] {
            let hits = store
                .search_tasks(&SearchTasksQuery {
                    query: query.into(),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(hits.len(), 1, "query `{query}` should match without FTS5 syntax error");
            assert_eq!(hits[0].task_id, "t-accent");
        }
    }

    #[test]
    fn search_tasks_does_not_let_one_chatty_task_crowd_out_other_matching_tasks() {
        let store = Store::open_in_memory().unwrap();
        let mk_task = |id: &str, title: &str, ts: i64| {
            let task = Task {
                id: id.into(),
                project_id: None,
                title: title.into(),
                workspace: TaskWorkspace::Root,
                parent_task_id: None,
                pinned: false,
                archived_at: None,
                created_at: ts,
                updated_at: ts,
            };
            let sess = TaskSession {
                id: format!("{id}-s"),
                task_id: id.into(),
                agent: AgentKind::CodexCli,
                instance_id: None,
                native_id: None,
                status: SessionStatus::Completed,
                options: SessionOptions::default(),
                created_at: ts,
                updated_at: ts,
            };
            store.insert_task(&task, &sess).unwrap();
        };

        // 先插入较旧的任务 t-other（1 条命中）
        mk_task("t-other", "Other task", 10);
        store
            .put_event(
                "t-other",
                &StoredEvent {
                    event: SessionEvent {
                        id: "e-other".into(),
                        session_id: "t-other-s".into(),
                        seq: 1,
                        ts: 11,
                        body: SessionEventBody::UserMessage {
                            text: "needle db check in other task".into(),
                            images: vec![],
                            annotations: 0,
                            sender: None,
                        },
                    },
                    rev: 1,
                },
                true,
                None,
            )
            .unwrap();

        // 再插入高频任务 t-chatty，包含 2,100 条更新的匹配消息（旧实现 LIMIT 2000 会把 t-other 完全挤掉）
        mk_task("t-chatty", "Chatty task", 20);
        {
            let mut conn = store.conn();
            let tx = conn.transaction().unwrap();
            for seq in 1..=2_100_u64 {
                let text = format!("needle db log line #{seq}");
                let body = SessionEventBody::UserMessage {
                    text,
                    images: vec![],
                    annotations: 0,
                    sender: None,
                };
                let ev_id = format!("e-chatty-{seq}");
                tx.execute(
                    "INSERT INTO event (session_id, seq, rev, id, ts, body) VALUES (?1, ?2, ?2, ?3, ?4, ?5)",
                    params!["t-chatty-s", seq as i64, &ev_id, (100 + seq) as i64, serde_json::to_string(&body).unwrap()],
                )
                .unwrap();
                upsert_event_doc(&tx, "t-chatty", "t-chatty-s", &ev_id, seq, &body).unwrap();
            }
            tx.execute("UPDATE task SET updated_at = 3000 WHERE id = 't-chatty'", [])
                .unwrap();
            tx.commit().unwrap();
        }

        // 长词走 FTS5 路径：两个任务都必须返回
        let long_hits = store
            .search_tasks(&SearchTasksQuery {
                query: "needle".into(),
                ..Default::default()
            })
            .unwrap();
        let long_ids: Vec<&str> = long_hits.iter().map(|h| h.task_id.as_str()).collect();
        assert!(long_ids.contains(&"t-chatty"));
        assert!(long_ids.contains(&"t-other"));

        // 短词走 LIKE 路径：两个任务同样必须返回
        let short_hits = store
            .search_tasks(&SearchTasksQuery {
                query: "db".into(),
                ..Default::default()
            })
            .unwrap();
        let short_ids: Vec<&str> = short_hits.iter().map(|h| h.task_id.as_str()).collect();
        assert!(short_ids.contains(&"t-chatty"));
        assert!(short_ids.contains(&"t-other"));
    }

    #[test]
    fn search_index_only_syncs_dirty_streaming_messages_on_turn_completion() {
        let store = Store::open_in_memory().unwrap();
        let task = Task {
            id: "t-dirty".into(),
            project_id: None,
            title: "Incremental sync".into(),
            workspace: TaskWorkspace::Root,
            parent_task_id: None,
            pinned: false,
            archived_at: None,
            created_at: 10,
            updated_at: 10,
        };
        let sess = TaskSession {
            id: "t-dirty-s".into(),
            task_id: "t-dirty".into(),
            agent: AgentKind::ClaudeCode,
            instance_id: None,
            native_id: None,
            status: SessionStatus::Running,
            options: SessionOptions::default(),
            created_at: 10,
            updated_at: 10,
        };
        store.insert_task(&task, &sess).unwrap();

        // 第 1 轮：流式写入并结束
        let put = |seq: u64, rev: u64, id: &str, body: SessionEventBody| {
            store
                .put_event(
                    "t-dirty",
                    &StoredEvent {
                        event: SessionEvent {
                            id: id.into(),
                            session_id: "t-dirty-s".into(),
                            seq,
                            ts: rev as i64,
                            body,
                        },
                        rev,
                    },
                    true,
                    None,
                )
                .unwrap();
        };
        put(
            1,
            1,
            "e1",
            SessionEventBody::AgentMessage {
                text: "turn1 initial".into(),
                stream_id: Some("s1".into()),
                phase: None,
                mode: None,
                dedupe_of: None,
            },
        );
        put(
            1,
            2,
            "e1",
            SessionEventBody::AgentMessage {
                text: "turn1 final_alpha".into(),
                stream_id: Some("s1".into()),
                phase: None,
                mode: None,
                dedupe_of: None,
            },
        );
        put(
            2,
            3,
            "st1",
            SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            },
        );

        let dirty_after_t1: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM search_dirty", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dirty_after_t1, 0);

        // 直接改写第 1 轮原始 event 行作为哨兵：若第 2 轮收尾全表重扫历史消息，该哨兵词就会被误扫入索引。
        let sentinel_body = serde_json::to_string(&SessionEventBody::AgentMessage {
            text: "turn1 sentinel_should_not_rescan".into(),
            stream_id: Some("s1".into()),
            phase: None,
            mode: None,
            dedupe_of: None,
        })
        .unwrap();
        store
            .conn()
            .execute(
                "UPDATE event SET body = ?1 WHERE session_id = 't-dirty-s' AND seq = 1",
                [&sentinel_body],
            )
            .unwrap();

        // 第 2 轮：流式写入新消息并结束
        put(
            3,
            4,
            "e2",
            SessionEventBody::AgentMessage {
                text: "turn2 start".into(),
                stream_id: Some("s2".into()),
                phase: None,
                mode: None,
                dedupe_of: None,
            },
        );
        put(
            3,
            5,
            "e2",
            SessionEventBody::AgentMessage {
                text: "turn2 final_beta".into(),
                stream_id: Some("s2".into()),
                phase: None,
                mode: None,
                dedupe_of: None,
            },
        );
        put(
            4,
            6,
            "st2",
            SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            },
        );

        // 第 2 轮新消息已增量刷入索引
        let beta_hits = store
            .search_tasks(&SearchTasksQuery {
                query: "final_beta".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(beta_hits.len(), 1);
        assert_eq!(beta_hits[0].event_id.as_deref(), Some("e2"));

        // 第 1 轮历史旧消息未被重新扫描处理
        let sentinel_hits = store
            .search_tasks(&SearchTasksQuery {
                query: "sentinel_should_not_rescan".into(),
                ..Default::default()
            })
            .unwrap();
        assert!(sentinel_hits.is_empty());
    }

    #[test]
    fn search_tasks_keeps_older_higher_scoring_starts_with_hit_beyond_four_messages() {
        let store = Store::open_in_memory().unwrap();
        let task = Task {
            id: "t-rank".into(),
            project_id: None,
            title: "Ranking test".into(),
            workspace: TaskWorkspace::Root,
            parent_task_id: None,
            pinned: false,
            archived_at: None,
            created_at: 10,
            updated_at: 10,
        };
        let sess = TaskSession {
            id: "t-rank-s".into(),
            task_id: "t-rank".into(),
            agent: AgentKind::CodexCli,
            instance_id: None,
            native_id: None,
            status: SessionStatus::Completed,
            options: SessionOptions::default(),
            created_at: 10,
            updated_at: 10,
        };
        store.insert_task(&task, &sess).unwrap();

        let put_user = |seq: u64, id: &str, text: &str| {
            store
                .put_event(
                    "t-rank",
                    &StoredEvent {
                        event: SessionEvent {
                            id: id.into(),
                            session_id: "t-rank-s".into(),
                            seq,
                            ts: (100 + seq) as i64,
                            body: SessionEventBody::UserMessage {
                                text: text.into(),
                                images: vec![],
                                annotations: 0,
                                sender: None,
                            },
                        },
                        rev: seq,
                    },
                    true,
                    None,
                )
                .unwrap();
        };

        // 第 1 条以目标词开头（长词 needle + 短词 db），随后追加 6 条仅在中间出现该词的更新消息。
        put_user(1, "e-starts-needle", "needle starts this sentence");
        put_user(2, "e-starts-db", "db starts this sentence");
        put_user(3, "e-starts-phrase", "auth flow starts right here");
        for i in 1..=6_u64 {
            let base = 3 + (i - 1) * 3;
            put_user(base + 1, &format!("e-mid-needle-{i}"), &format!("middle mention of needle #{i}"));
            put_user(base + 2, &format!("e-mid-db-{i}"), &format!("middle mention of db #{i}"));
            put_user(base + 3, &format!("e-mid-phrase-{i}"), &format!("unrelated flow around auth #{i}"));
        }

        let needle_hits = store
            .search_tasks(&SearchTasksQuery {
                query: "needle".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(needle_hits.len(), 1);
        assert_eq!(
            needle_hits[0].event_id.as_deref(),
            Some("e-starts-needle"),
            "older starts_with match must not be evicted by newer middle matches"
        );

        let db_hits = store
            .search_tasks(&SearchTasksQuery {
                query: "db".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(db_hits.len(), 1);
        assert_eq!(
            db_hits[0].event_id.as_deref(),
            Some("e-starts-db"),
            "older short-term starts_with match must not be evicted by newer middle matches"
        );

        let phrase_hits = store
            .search_tasks(&SearchTasksQuery {
                query: "auth flow".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(phrase_hits.len(), 1);
        assert_eq!(
            phrase_hits[0].event_id.as_deref(),
            Some("e-starts-phrase"),
            "older multi-term exact phrase starts_with match must win"
        );
    }
}
