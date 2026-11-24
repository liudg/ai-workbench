//! 多账号与多实例隔离管理（`instances.*` RPC 与 `TOPIC_AGENT_INSTANCES` 广播）。

use aiwb_core::models::{
    default_instance_id, paths_overlap, sanitize_id_segment, AgentEnvVar, AgentInstance, AgentKind,
    AgentProfile, IsolationMode,
};
use aiwb_core::rpc::TOPIC_AGENT_INSTANCES;
use serde::Deserialize;

use super::{now_millis, session_busy, ServiceResult, Services};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertInstanceParam {
    #[serde(default)]
    pub id: Option<String>,
    pub kind: AgentKind,
    pub display_name: String,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub binary_path: Option<String>,
    #[serde(default)]
    pub launch_args: Vec<String>,
    #[serde(default)]
    pub environment: Vec<AgentEnvVar>,
    #[serde(default)]
    pub isolation_mode: IsolationMode,
    #[serde(default)]
    pub home_path: Option<String>,
    #[serde(default)]
    pub shared_home_path: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveInstanceParam {
    pub id: String,
    #[serde(default)]
    pub delete_data: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetDefaultInstanceParam {
    pub kind: AgentKind,
}

fn normalize_opt(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn slugify_instance_id(kind: AgentKind, raw: Option<&str>) -> String {
    if let Some(id) = raw.map(str::trim).filter(|s| !s.is_empty()) {
        let cleaned = sanitize_id_segment(&id.to_ascii_lowercase(), "");
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    let short = &uuid::Uuid::new_v4().simple().to_string()[..8];
    format!("{}-{short}", kind.as_str())
}

impl Services {
    pub(crate) fn list_instances(&self) -> ServiceResult<Vec<AgentInstance>> {
        let list = self
            .store
            .list_agent_instances()
            .map_err(|e| e.to_string())?;
        Ok(list.into_iter().map(|item| item.redacted()).collect())
    }

    pub(crate) async fn upsert_instance(
        &self,
        params: UpsertInstanceParam,
    ) -> ServiceResult<AgentInstance> {
        let base_caps = aiwb_agents::adapter_for(params.kind).capabilities();
        if !base_caps.supports_multi_instance {
            return Err(format!(
                "{} 暂不支持多实例隔离配置",
                params.kind.display_name()
            ));
        }
        if params.isolation_mode == IsolationMode::ShadowHome && !base_caps.supports_shadow_home {
            return Err(format!(
                "{} 不支持影子主目录模式，请选择独立配置目录或沿用本机默认",
                params.kind.display_name()
            ));
        }

        let display_name = params.display_name.trim().to_string();
        if display_name.is_empty() {
            return Err("实例名称不能为空".into());
        }

        let id = slugify_instance_id(params.kind, params.id.as_deref());
        let existing = self
            .store
            .agent_instance(&id)
            .map_err(|e| e.to_string())?;
        if let Some(prev) = &existing {
            if prev.kind != params.kind {
                return Err("不能更改已有实例的 Agent 类型".into());
            }
        }

        let is_default = id == default_instance_id(params.kind)
            || existing.as_ref().is_some_and(|i| i.is_default);
        let now = now_millis();
        let created_at = existing
            .as_ref()
            .map(|i| if i.created_at > 0 { i.created_at } else { now })
            .unwrap_or(now);
        let sort_order = params
            .sort_order
            .or_else(|| existing.as_ref().map(|i| i.sort_order))
            .unwrap_or(100);

        let instance = AgentInstance {
            id: id.clone(),
            kind: params.kind,
            display_name,
            accent_color: normalize_opt(params.accent_color),
            binary_path: normalize_opt(params.binary_path),
            launch_args: params
                .launch_args
                .into_iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect(),
            environment: params
                .environment
                .into_iter()
                .filter(|item| !item.name.trim().is_empty())
                .map(|mut item| {
                    item.name = item.name.trim().to_string();
                    item
                })
                .collect(),
            isolation_mode: params.isolation_mode,
            home_path: normalize_opt(params.home_path),
            shared_home_path: normalize_opt(params.shared_home_path),
            enabled: params.enabled,
            is_default,
            sort_order,
            created_at,
            updated_at: now,
        };

        let overlay =
            aiwb_agents::InstanceOverlay::from_instance(&instance, &self.runtimes.instances_root);
        if instance.isolation_mode == IsolationMode::ShadowHome {
            if let (Some(h), Some(s)) = (&overlay.home_path, &overlay.shared_home_path) {
                if paths_overlap(h, s) {
                    return Err("影子目录不能与共享主目录相同或互为父子目录".into());
                }
            }
        }

        let saved = self
            .store
            .upsert_agent_instance(&instance)
            .map_err(|e| e.to_string())?;
        self.runtimes.invalidate_instance_adapter(&saved.id);
        self.publish_instances()?;

        // 配置变更后停掉该实例空闲的已打开会话进程，下次用到时用新环境重新拉起。
        self.stop_idle_sessions_of_instance(&saved.id, saved.kind)
            .await;

        if saved.enabled {
            if let Ok(adapter) = self
                .runtimes
                .adapter_for_instance(saved.kind, Some(&saved.id))
            {
                if adapter.detect().await.is_ok() {
                    if adapter.session_linked() {
                        self.runtimes.prewarm_instance_catalogs(
                            vec![(saved.kind, saved.id.clone())],
                            self.prewarm_dir(),
                            true,
                        );
                    }
                } else {
                    self.runtimes.forget_instance_probe(&saved.id);
                }
            }
        } else {
            self.runtimes.forget_instance_probe(&saved.id);
        }

        Ok(saved.redacted())
    }

    pub(crate) async fn remove_instance(&self, params: RemoveInstanceParam) -> ServiceResult<bool> {
        let id = params.id.trim();
        let Some(inst) = self
            .store
            .agent_instance(id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(false);
        };
        if inst.is_default || id == default_instance_id(inst.kind) {
            return Err("内置默认实例不能删除，可选择停用或恢复默认配置".into());
        }

        let sessions = self.store.all_sessions().map_err(|e| e.to_string())?;
        for s in &sessions {
            if s.effective_instance_id() == id && session_busy(s) {
                return Err("该实例仍有正在运行的会话，请先停止后再删除".into());
            }
        }
        self.stop_idle_sessions_of_instance(id, inst.kind).await;

        let removed = self
            .store
            .remove_agent_instance(id)
            .map_err(|e| e.to_string())?;
        if removed && params.delete_data {
            let safe_id = sanitize_id_segment(id, "instance");
            if !safe_id.is_empty() {
                let managed_dir = self.runtimes.instances_root.join(&safe_id);
                if managed_dir.starts_with(&self.runtimes.instances_root) && managed_dir.is_dir() {
                    aiwb_agents::instance::remove_managed_instance_dir(&managed_dir);
                }
            }
        }
        self.runtimes.invalidate_instance_adapter(id);
        self.runtimes.forget_instance_probe(id);
        self.publish_instances()?;
        Ok(removed)
    }

    pub(crate) async fn reset_default_instance(
        &self,
        params: ResetDefaultInstanceParam,
    ) -> ServiceResult<AgentInstance> {
        let inst = self
            .store
            .reset_builtin_instance(params.kind)
            .map_err(|e| e.to_string())?;
        self.runtimes.invalidate_instance_adapter(&inst.id);
        self.runtimes.forget_instance_probe(&inst.id);
        self.stop_idle_sessions_of_instance(&inst.id, inst.kind).await;
        if let Ok(adapter) = self
            .runtimes
            .adapter_for_instance(inst.kind, Some(&inst.id))
        {
            if inst.enabled && adapter.session_linked() && adapter.detect().await.is_ok() {
                self.runtimes.prewarm_instance_catalogs(
                    vec![(inst.kind, inst.id.clone())],
                    self.prewarm_dir(),
                    true,
                );
            }
        }
        self.publish_instances()?;
        Ok(inst.redacted())
    }

    async fn stop_idle_sessions_of_instance(&self, instance_id: &str, kind: AgentKind) {
        if let Ok(sides) = self.store.side_sessions() {
            for s in sides {
                if s.agent == kind && s.effective_instance_id() == instance_id && !session_busy(&s)
                {
                    let _ = self.runtimes.discard_side(&s.id).await;
                }
            }
        }
        let Ok(sessions) = self.store.list_sessions() else {
            return;
        };
        for s in sessions {
            if s.agent == kind && s.effective_instance_id() == instance_id && !session_busy(&s) {
                self.runtimes.stop_and_mute(&s.id).await;
            }
        }
    }

    pub(crate) fn publish_instances(&self) -> ServiceResult<()> {
        self.hub.publish_with(TOPIC_AGENT_INSTANCES, || {
            let list = self.list_instances()?;
            Ok(((), serde_json::to_value(list).map_err(|e| e.to_string())?))
        })
    }

    /// 返回给前端的完整 Profile 列表：
    /// 已启用的多实例各自返回一条带 `instance_id`、`display_name`、`accent_color` 的 Profile；
    /// 若某 AgentKind 的全部实例均被停用，保底保留一条默认种类 Profile 以便历史会话图标渲染。
    pub(crate) fn agent_profiles(&self) -> Vec<AgentProfile> {
        let instances = self.store.list_agent_instances().unwrap_or_default();
        let mut out = Vec::new();
        for kind in AgentKind::all() {
            let kind_instances: Vec<&AgentInstance> = instances
                .iter()
                .filter(|item| item.kind == kind && item.enabled)
                .collect();
            if kind_instances.is_empty() {
                let adapter = self.runtimes.adapter(kind);
                out.push(aiwb_agents::profile_for_adapter(adapter.as_ref()));
            } else {
                for inst in kind_instances {
                    let Ok(adapter) = self
                        .runtimes
                        .adapter_for_instance(inst.kind, Some(&inst.id))
                    else {
                        continue;
                    };
                    let mut profile = aiwb_agents::profile_for_adapter(adapter.as_ref());
                    if !inst.is_default {
                        profile.instance_id = Some(inst.id.clone());
                    }
                    if !inst.display_name.trim().is_empty()
                        && (!inst.is_default || inst.display_name != inst.kind.display_name())
                    {
                        profile.display_name = Some(inst.display_name.clone());
                    }
                    if inst.accent_color.is_some() {
                        profile.accent_color = inst.accent_color.clone();
                    }
                    out.push(profile);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_instance_id_trims_hyphens_and_never_collides_on_non_ascii_names() {
        let a = slugify_instance_id(AgentKind::ClaudeCode, Some("工作"));
        let b = slugify_instance_id(AgentKind::ClaudeCode, Some("个人"));
        assert!(a.starts_with("claude-code-"));
        assert!(b.starts_with("claude-code-"));
        assert_ne!(a, b);
        assert_eq!(
            slugify_instance_id(AgentKind::CodexCli, Some(" -My.Work-- ")),
            "my-work"
        );
    }
}
