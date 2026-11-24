use serde::{Deserialize, Serialize};

use super::agent::AgentKind;

/// 前端展示已保存敏感环境变量时的掩码占位值。
pub const SECRET_REDACTED: &str = "••••••••";

fn default_true() -> bool {
    true
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// 每种 Agent 内置默认实例的固定 id，和旧版单实例主键保持一致，免迁移即可路由。
pub fn default_instance_id(kind: AgentKind) -> String {
    kind.as_str().to_string()
}

/// 解析会话或请求的有效实例 id：为空时回退到 `kind.as_str()`。
pub fn effective_instance_id(kind: AgentKind, instance_id: Option<&str>) -> &str {
    instance_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| kind.as_str())
}

/// 将标识段清洗为仅含 ASCII 字母、数字、`-`、`_` 的安全名称，去掉首尾 `-`；为空时返回 `fallback`。
pub fn sanitize_id_segment(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 实例配置目录隔离方式。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsolationMode {
    /// 走宿主机全局默认目录（内置默认实例缺省行为）。
    #[default]
    HostDefault,
    /// 完全独立的配置目录（如独立 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `CURSOR_CONFIG_DIR` / `ANTIGRAVITY_GEMINI_DIR`）。
    IsolatedHome,
    /// Codex 影子主目录：独立 `auth.json` 与模型缓存，软链/Junction 共享主目录的 `skills`、`sessions`、`plugins`。
    ShadowHome,
}

/// 实例级环境变量覆盖项。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnvVar {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub sensitive: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub value_redacted: bool,
}

/// 一个可配置的 Agent 实例（例如个人订阅 vs 工作订阅、官方连接 vs 第三方 API 网关）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstance {
    pub id: String,
    pub kind: AgentKind,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launch_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment: Vec<AgentEnvVar>,
    #[serde(default)]
    pub isolation_mode: IsolationMode,
    /// 自定义配置目录或 Shadow Home 目录；为空且 `isolation_mode != HostDefault` 时由工作台托管在数据目录下。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_path: Option<String>,
    /// `ShadowHome` 模式下被共享的源主目录（缺省为 `~/.codex`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_home_path: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AgentInstance {
    /// 生成内置默认实例（使用宿主全局默认目录）。
    pub fn builtin(kind: AgentKind) -> Self {
        Self {
            id: default_instance_id(kind),
            kind,
            display_name: kind.display_name().to_string(),
            accent_color: None,
            binary_path: None,
            launch_args: Vec::new(),
            environment: Vec::new(),
            isolation_mode: IsolationMode::HostDefault,
            home_path: None,
            shared_home_path: None,
            enabled: true,
            is_default: true,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// 发给前端时把敏感环境变量的值抹掉，标上 `value_redacted = true`。
    pub fn redacted(&self) -> Self {
        let mut copy = self.clone();
        for item in &mut copy.environment {
            if item.sensitive && !item.value.is_empty() {
                item.value.clear();
                item.value_redacted = true;
            } else {
                item.value_redacted = false;
            }
        }
        copy
    }

    /// 前端回传编辑结果时，若某项带 `value_redacted` 或值为掩码串，则尝试沿用旧库里的明文；无匹配旧值时清空，绝不落盘掩码字面量。
    pub fn merge_secrets(&mut self, previous: Option<&AgentInstance>) {
        for item in &mut self.environment {
            let masked = item.value_redacted || item.value == SECRET_REDACTED;
            if masked {
                if item.sensitive {
                    item.value = previous
                        .and_then(|p| {
                            p.environment
                                .iter()
                                .find(|existing| existing.name == item.name)
                        })
                        .map(|prev| prev.value.clone())
                        .unwrap_or_default();
                } else {
                    item.value.clear();
                }
            }
            item.value_redacted = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_and_restores_sensitive_env_vars() {
        let mut inst = AgentInstance::builtin(AgentKind::ClaudeCode);
        inst.environment = vec![
            AgentEnvVar {
                name: "ANTHROPIC_BASE_URL".into(),
                value: "https://api.example.com".into(),
                sensitive: false,
                value_redacted: false,
            },
            AgentEnvVar {
                name: "ANTHROPIC_API_KEY".into(),
                value: "sk-secret-123".into(),
                sensitive: true,
                value_redacted: false,
            },
        ];

        let public = inst.redacted();
        assert_eq!(public.environment[0].value, "https://api.example.com");
        assert!(!public.environment[0].value_redacted);
        assert_eq!(public.environment[1].value, "");
        assert!(public.environment[1].value_redacted);

        let mut edited = public.clone();
        edited.merge_secrets(Some(&inst));
        assert_eq!(edited.environment[1].value, "sk-secret-123");
        assert!(!edited.environment[1].value_redacted);
    }

    #[test]
    fn merge_secrets_clears_unmatched_masked_values_instead_of_persisting_placeholder() {
        let mut incoming = AgentInstance::builtin(AgentKind::ClaudeCode);
        incoming.environment = vec![
            AgentEnvVar {
                name: "NEW_SECRET_KEY".into(),
                value: SECRET_REDACTED.into(),
                sensitive: true,
                value_redacted: true,
            },
            AgentEnvVar {
                name: "NON_SENSITIVE_MASKED".into(),
                value: SECRET_REDACTED.into(),
                sensitive: false,
                value_redacted: false,
            },
        ];

        let mut previous = AgentInstance::builtin(AgentKind::ClaudeCode);
        previous.environment = vec![AgentEnvVar {
            name: "OTHER_KEY".into(),
            value: "real-secret".into(),
            sensitive: true,
            value_redacted: false,
        }];

        incoming.merge_secrets(Some(&previous));
        assert_eq!(incoming.environment[0].value, "");
        assert!(!incoming.environment[0].value_redacted);
        assert_eq!(incoming.environment[1].value, "");
        assert!(!incoming.environment[1].value_redacted);

        let mut fresh = AgentInstance::builtin(AgentKind::CodexCli);
        fresh.environment = vec![AgentEnvVar {
            name: "OPENAI_API_KEY".into(),
            value: SECRET_REDACTED.into(),
            sensitive: true,
            value_redacted: false,
        }];
        fresh.merge_secrets(None);
        assert_eq!(fresh.environment[0].value, "");
    }

    #[test]
    fn sanitize_id_segment_and_effective_instance_id_handle_edge_cases() {
        assert_eq!(sanitize_id_segment("工作", "fallback"), "fallback");
        assert_eq!(sanitize_id_segment("---", "fallback"), "fallback");
        assert_eq!(sanitize_id_segment("-my.work/id-", "fallback"), "my-work-id");
        assert_eq!(effective_instance_id(AgentKind::CodexCli, None), "codex-cli");
        assert_eq!(effective_instance_id(AgentKind::CodexCli, Some("  ")), "codex-cli");
        assert_eq!(effective_instance_id(AgentKind::CodexCli, Some("work")), "work");
    }
}
