//! 多账号与多网关实例配置存储（`agent_instance` 表）。

use std::collections::HashMap;

use aiwb_core::models::{default_instance_id, AgentEnvVar, AgentInstance, AgentKind, IsolationMode};
use rusqlite::{params, OptionalExtension, Row};

use crate::tasks::{enum_text, from_enum, from_text, to_text};
use crate::{Store, StoreError, StoreResult};

fn instance_from_row(row: &Row<'_>) -> rusqlite::Result<AgentInstance> {
    let kind_raw: String = row.get("kind")?;
    let args_raw: String = row.get("launch_args")?;
    let env_raw: String = row.get("environment")?;
    let mode_raw: String = row.get("isolation_mode")?;
    let id: String = row.get("id")?;
    let kind: AgentKind = from_enum("kind", &kind_raw)?;
    let is_builtin = id == default_instance_id(kind);
    let is_default_col: bool = row.get("is_default")?;
    Ok(AgentInstance {
        id,
        kind,
        display_name: row.get("display_name")?,
        accent_color: row.get("accent_color")?,
        binary_path: row.get("binary_path")?,
        launch_args: from_text::<Vec<String>>("launch_args", &args_raw)?,
        environment: from_text::<Vec<AgentEnvVar>>("environment", &env_raw)?,
        isolation_mode: from_enum::<IsolationMode>("isolation_mode", &mode_raw)?,
        home_path: row.get("home_path")?,
        shared_home_path: row.get("shared_home_path")?,
        enabled: row.get("enabled")?,
        is_default: is_builtin || is_default_col,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn builtin_kind_for_id(id: &str) -> Option<AgentKind> {
    AgentKind::all().into_iter().find(|k| k.as_str() == id)
}

impl Store {
    /// 列出全部实例（内置默认实例始终存在；数据库里有覆盖行时以库里为准）。
    pub fn list_agent_instances(&self) -> StoreResult<Vec<AgentInstance>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM agent_instance ORDER BY sort_order ASC, created_at ASC, id ASC",
        )?;
        let stored: Vec<AgentInstance> = stmt
            .query_map([], instance_from_row)?
            .collect::<Result<_, _>>()?;

        let mut by_id: HashMap<String, AgentInstance> =
            stored.into_iter().map(|inst| (inst.id.clone(), inst)).collect();

        let mut out = Vec::new();
        for (idx, kind) in AgentKind::all().into_iter().enumerate() {
            let def_id = default_instance_id(kind);
            if let Some(mut existing) = by_id.remove(&def_id) {
                existing.is_default = true;
                out.push(existing);
            } else {
                let mut builtin = AgentInstance::builtin(kind);
                builtin.sort_order = idx as i64;
                out.push(builtin);
            }
        }

        let mut extras: Vec<AgentInstance> = by_id.into_values().collect();
        extras.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        out.extend(extras);
        Ok(out)
    }

    /// 读取单个实例（包含含明文密钥的完整环境变量，仅供后端启动 CLI 使用）。
    pub fn agent_instance(&self, id: &str) -> StoreResult<Option<AgentInstance>> {
        let found = self
            .conn()
            .query_row(
                "SELECT * FROM agent_instance WHERE id = ?1",
                [id],
                instance_from_row,
            )
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
        Ok(builtin_kind_for_id(id).map(AgentInstance::builtin))
    }

    /// 新增或更新实例（自动合并未改动的掩码敏感环境变量）。
    pub fn upsert_agent_instance(&self, input: &AgentInstance) -> StoreResult<AgentInstance> {
        let trimmed_id = input.id.trim();
        if trimmed_id.is_empty() {
            return Err(StoreError::Invalid("实例 ID 不能为空".into()));
        }
        if let Some(builtin_kind) = builtin_kind_for_id(trimmed_id) {
            if builtin_kind != input.kind {
                return Err(StoreError::Invalid("内置默认实例不能更改 Agent 种类".into()));
            }
        }
        let previous = self.agent_instance(trimmed_id)?;
        let mut merged = input.clone();
        merged.id = trimmed_id.to_string();
        if merged.display_name.trim().is_empty() {
            merged.display_name = merged.kind.display_name().to_string();
        }
        merged.is_default = builtin_kind_for_id(trimmed_id).is_some();
        merged.merge_secrets(previous.as_ref());

        self.conn().execute(
            "INSERT INTO agent_instance (
                id, kind, display_name, accent_color, binary_path, launch_args, environment,
                isolation_mode, home_path, shared_home_path, enabled, is_default, sort_order,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                accent_color = excluded.accent_color,
                binary_path = excluded.binary_path,
                launch_args = excluded.launch_args,
                environment = excluded.environment,
                isolation_mode = excluded.isolation_mode,
                home_path = excluded.home_path,
                shared_home_path = excluded.shared_home_path,
                enabled = excluded.enabled,
                is_default = excluded.is_default,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at",
            params![
                merged.id,
                enum_text(&merged.kind),
                merged.display_name,
                merged.accent_color,
                merged.binary_path,
                to_text(&merged.launch_args),
                to_text(&merged.environment),
                enum_text(&merged.isolation_mode),
                merged.home_path,
                merged.shared_home_path,
                merged.enabled,
                merged.is_default,
                merged.sort_order,
                merged.created_at,
                merged.updated_at,
            ],
        )?;
        Ok(merged)
    }

    /// 删除自定义实例；内置默认实例只可重置，不可删除。
    pub fn remove_agent_instance(&self, id: &str) -> StoreResult<bool> {
        if builtin_kind_for_id(id).is_some() {
            return Err(StoreError::Invalid("内置默认实例不能删除，可恢复默认设置".into()));
        }
        Ok(self
            .conn()
            .execute("DELETE FROM agent_instance WHERE id = ?1", [id])?
            > 0)
    }

    /// 将内置默认实例的自定义覆盖恢复回宿主缺省。
    pub fn reset_builtin_instance(&self, kind: AgentKind) -> StoreResult<AgentInstance> {
        let id = default_instance_id(kind);
        self.conn()
            .execute("DELETE FROM agent_instance WHERE id = ?1", [&id])?;
        Ok(AgentInstance::builtin(kind))
    }
}
