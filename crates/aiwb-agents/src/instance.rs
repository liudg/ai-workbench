//! Agent 实例运行时覆盖层：二进制路径、启动参数、环境变量与隔离主目录解析。

use std::path::{Path, PathBuf};

pub use aiwb_core::models::paths_overlap;
use aiwb_core::models::{
    default_instance_id, sanitize_id_segment, AgentInstance, AgentKind, IsolationMode,
};
use tokio::process::Command;

const CONFIG_DIR_ENV_KEYS: &[&str] = &[
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CURSOR_CONFIG_DIR",
    "ANTIGRAVITY_GEMINI_DIR",
];

fn is_config_dir_env_key(key: &str) -> bool {
    CONFIG_DIR_ENV_KEYS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(key))
}

#[derive(Debug, Clone, Default)]
pub struct InstanceOverlay {
    pub instance_id: String,
    pub display_name: Option<String>,
    pub accent_color: Option<String>,
    pub binary_path: Option<PathBuf>,
    pub launch_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub isolation_mode: IsolationMode,
    pub home_path: Option<PathBuf>,
    pub shared_home_path: Option<PathBuf>,
}

pub fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

pub fn expand_tilde(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        if let Some(home) = user_home_dir() {
            return home;
        }
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = user_home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

pub(crate) fn host_env_dir(key: &str) -> Option<PathBuf> {
    let raw = std::env::var_os(key)?;
    if raw.is_empty() {
        return None;
    }
    match raw.to_str() {
        Some(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| expand_tilde(trimmed))
        }
        None => Some(PathBuf::from(raw)),
    }
}

impl InstanceOverlay {
    pub fn default_for(kind: AgentKind) -> Self {
        Self {
            instance_id: default_instance_id(kind),
            display_name: None,
            accent_color: None,
            binary_path: None,
            launch_args: Vec::new(),
            env: Vec::new(),
            isolation_mode: IsolationMode::HostDefault,
            home_path: None,
            shared_home_path: None,
        }
    }

    pub fn from_instance(inst: &AgentInstance, instances_root: &Path) -> Self {
        let binary_path = inst
            .binary_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(expand_tilde);
        let explicit_home = inst
            .home_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(expand_tilde);
        let explicit_shared = inst
            .shared_home_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(expand_tilde);

        let safe_id = sanitize_id_segment(&inst.id, "instance");
        let (home_path, shared_home_path) = match inst.isolation_mode {
            IsolationMode::HostDefault => (explicit_home, explicit_shared),
            IsolationMode::IsolatedHome => {
                let home = explicit_home
                    .unwrap_or_else(|| instances_root.join(&safe_id).join("home"));
                (Some(home), explicit_shared)
            }
            IsolationMode::ShadowHome => {
                let home = explicit_home
                    .unwrap_or_else(|| instances_root.join(&safe_id).join("codex-shadow"));
                let shared = explicit_shared
                    .or_else(|| user_home_dir().map(|h| h.join(".codex")));
                (Some(home), shared)
            }
        };

        let env = inst
            .environment
            .iter()
            .filter(|item| !item.name.trim().is_empty())
            .map(|item| {
                let name = item.name.trim().to_string();
                let value = if is_config_dir_env_key(&name) && !item.value.trim().is_empty() {
                    expand_tilde(item.value.trim())
                        .to_string_lossy()
                        .into_owned()
                } else {
                    item.value.clone()
                };
                (name, value)
            })
            .collect();

        Self {
            instance_id: inst.id.clone(),
            display_name: Some(inst.display_name.clone()),
            accent_color: inst.accent_color.clone(),
            binary_path,
            launch_args: inst
                .launch_args
                .iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect(),
            env,
            isolation_mode: inst.isolation_mode,
            home_path,
            shared_home_path,
        }
    }

    pub fn is_isolated(&self) -> bool {
        self.isolation_mode != IsolationMode::HostDefault || self.home_path.is_some()
    }

    pub fn env_var(&self, key: &str) -> Option<&str> {
        self.env
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }

    /// 统一解析实例的配置根目录：
    /// 1. `overlay.env` 中的显式 `env_key`（如 `CLAUDE_CONFIG_DIR`）；
    /// 2. `overlay.home_path`（隔离主目录或自定义主目录）；
    /// 3. 若实例开启隔离但未设上述两项，回退 `~/<default_dot_dir>`（屏蔽宿主进程残留环境变量）；
    /// 4. 否则读取宿主进程环境变量 `env_key`，再回退 `~/<default_dot_dir>`。
    pub fn resolve_config_dir(&self, env_key: &str, default_dot_dir: &str) -> Option<PathBuf> {
        if let Some(val) = self.env_var(env_key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(expand_tilde(trimmed));
            }
        }
        if let Some(home) = self.home_path.as_ref() {
            return Some(home.clone());
        }
        if self.is_isolated() {
            return user_home_dir().map(|home| home.join(default_dot_dir));
        }
        host_env_dir(env_key).or_else(|| user_home_dir().map(|home| home.join(default_dot_dir)))
    }

    pub fn apply_env(&self, command: &mut Command) {
        for (k, v) in &self.env {
            if is_config_dir_env_key(k) && !v.trim().is_empty() {
                command.env(k, expand_tilde(v.trim()));
            } else {
                command.env(k, v);
            }
        }
    }
}

/// 安全删除工作台托管的实例目录：先显式摘除其中的软链 / NTFS Junction 重解析点，绝不递归穿透到宿主共享目录。
pub fn remove_managed_instance_dir(dir: &Path) {
    fn unlink_reparse_points(current: &Path) {
        if crate::codex::shadow_home::is_reparse_or_symlink(current) {
            let _ = crate::codex::shadow_home::remove_link(current);
            return;
        }
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if crate::codex::shadow_home::is_reparse_or_symlink(&p) {
                let _ = crate::codex::shadow_home::remove_link(&p);
            } else if p.is_dir() {
                unlink_reparse_points(&p);
            }
        }
    }
    if dir.exists() {
        unlink_reparse_points(dir);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::models::AgentEnvVar;

    #[test]
    fn expands_tilde_for_config_dir_env_vars_in_from_instance_and_apply_env() {
        let Some(home) = user_home_dir() else {
            return;
        };
        let mut inst = AgentInstance::builtin(AgentKind::ClaudeCode);
        inst.environment = vec![
            AgentEnvVar {
                name: "CODEX_HOME".into(),
                value: "~/.codex-work".into(),
                sensitive: false,
                value_redacted: false,
            },
            AgentEnvVar {
                name: "CLAUDE_CONFIG_DIR".into(),
                value: "~/.claude-work".into(),
                sensitive: false,
                value_redacted: false,
            },
            AgentEnvVar {
                name: "CURSOR_CONFIG_DIR".into(),
                value: "~/.cursor-work".into(),
                sensitive: false,
                value_redacted: false,
            },
            AgentEnvVar {
                name: "ANTIGRAVITY_GEMINI_DIR".into(),
                value: "~/.gemini-work".into(),
                sensitive: false,
                value_redacted: false,
            },
            AgentEnvVar {
                name: "UNRELATED_TOKEN".into(),
                value: "~/keep-literal".into(),
                sensitive: true,
                value_redacted: false,
            },
        ];

        let root = std::env::temp_dir().join("aiwb-inst-tilde-test");
        let overlay = InstanceOverlay::from_instance(&inst, &root);

        for (key, suffix) in [
            ("CODEX_HOME", ".codex-work"),
            ("CLAUDE_CONFIG_DIR", ".claude-work"),
            ("CURSOR_CONFIG_DIR", ".cursor-work"),
            ("ANTIGRAVITY_GEMINI_DIR", ".gemini-work"),
        ] {
            let expected = home.join(suffix);
            assert_eq!(
                Path::new(overlay.env_var(key).unwrap()),
                expected.as_path(),
                "{key} should be tilde-expanded in overlay.env"
            );
            assert_eq!(
                overlay.resolve_config_dir(key, ".default").as_deref(),
                Some(expected.as_path())
            );
        }
        assert_eq!(overlay.env_var("UNRELATED_TOKEN"), Some("~/keep-literal"));

        // 即使直接构造未展开的 InstanceOverlay，apply_env 写给子进程的环境变量同样展开 `~`。
        let manual = InstanceOverlay {
            env: vec![("CLAUDE_CONFIG_DIR".into(), "~/.claude-direct".into())],
            ..Default::default()
        };
        let mut cmd = Command::new("git");
        manual.apply_env(&mut cmd);
        let applied: Vec<_> = cmd
            .as_std()
            .get_envs()
            .filter(|(k, _)| *k == "CLAUDE_CONFIG_DIR")
            .collect();
        assert_eq!(applied.len(), 1);
        assert_eq!(
            applied[0].1.map(Path::new),
            Some(home.join(".claude-direct").as_path())
        );
    }
}
