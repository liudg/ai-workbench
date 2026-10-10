//! Codex 沙箱选择到 app-server 字段的映射。
//!
//! 桌面端菜单和这里的档位一一对应：
//! - 询问批准 → sandbox `workspace-write`，approval `on-request`，reviewer `user`
//! - 替我批准 → 同一 sandbox / approval，reviewer `auto_review`（`--approve-for-me`）
//! - 完全访问 → sandbox `danger-full-access`，approval `never`
//! - 只读     → sandbox `read-only`，approval `on-request`
//! - 自定义   → `permissions` 具名配置档，不能再带 `sandbox`
//!
//! 网络和额外可写目录只作用于询问批准、替我批准和只读。
//! workspace-write 的网络与 `--add-dir` 走 `sandbox_workspace_write`；
//! 只读的网络走回合 `sandboxPolicy.networkAccess`。

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{strip_verbatim_prefix, PermissionMenu, PermissionProfileOption};

use super::state::{Access, Shared};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SandboxChoice {
    pub mode: Access,
    pub approve_for_me: bool,
    pub network_access: bool,
    pub writable_roots: Vec<String>,
    pub profile_id: String,
}

/// 本机 app-server 是否接受 reviewer / 具名配置档。探测前保持关闭。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) struct SandboxWire {
    pub reviewer: bool,
    pub profiles: bool,
}

impl SandboxChoice {
    pub(super) fn full() -> Self {
        Self {
            mode: Access::Full,
            approve_for_me: false,
            network_access: false,
            writable_roots: Vec::new(),
            profile_id: String::new(),
        }
    }

    pub(super) fn from_mode(raw: &str) -> Self {
        Self::from_parts(raw, false, &[], "", "").unwrap_or_else(|_| Self::full())
    }

    pub(super) fn from_parts(
        mode: &str,
        network_access: bool,
        writable_roots: &[String],
        profile_id: &str,
        cwd: &str,
    ) -> Result<Self, AgentError> {
        let profile_id = profile_id.trim().to_string();
        if !profile_id.is_empty() {
            if profile_id.starts_with(':') {
                return Err(AgentError::Runtime(
                    "内置档位请直接选择询问批准、只读、替我批准或完全访问".into(),
                ));
            }
            return Ok(Self {
                mode: Access::Ask,
                approve_for_me: false,
                network_access: false,
                writable_roots: Vec::new(),
                profile_id,
            });
        }
        let mut choice = Self::full();
        if !choice.apply_preset(mode) {
            return Err(AgentError::Runtime(format!("未知权限档位：{mode}")));
        }
        if choice.mode != Access::Full {
            choice.network_access = network_access;
            choice.writable_roots = normalize_writable_roots(cwd, writable_roots);
        }
        Ok(choice)
    }

    /// 切换预设时保留网络和额外目录，方便从完全访问切回来。
    pub(super) fn apply_preset(&mut self, raw: &str) -> bool {
        let key = raw.trim();
        if key.is_empty() {
            return false;
        }
        if is_approve_for_me(key) {
            self.mode = Access::Ask;
            self.approve_for_me = true;
            self.profile_id.clear();
            return true;
        }
        let Some(mode) = Access::parse(key) else {
            return false;
        };
        self.mode = mode;
        self.approve_for_me = false;
        self.profile_id.clear();
        true
    }

    pub(super) fn label(&self) -> String {
        if !self.profile_id.is_empty() {
            return self.profile_id.clone();
        }
        if self.approve_for_me {
            return "替我批准".into();
        }
        self.mode.label().to_string()
    }

    pub(super) fn reviewer(&self) -> &'static str {
        if self.approve_for_me {
            "auto_review"
        } else {
            "user"
        }
    }

    pub(super) fn uses_sandbox_network(&self) -> bool {
        self.profile_id.is_empty() && self.mode != Access::Full
    }

    /// `thread/start` 里除 cwd / ephemeral 以外的权限字段。
    pub(super) fn thread_permissions(&self, wire: SandboxWire) -> Value {
        if self.profile_active(wire) {
            let mut value = json!({
                "approvalPolicy": "on-request",
                "permissions": self.profile_id,
            });
            self.attach_reviewer(&mut value, wire);
            return value;
        }
        let mut value = json!({
            "approvalPolicy": self.mode.approval_policy(),
            "sandbox": self.mode.sandbox_mode(),
        });
        self.attach_reviewer(&mut value, wire);
        if self.uses_sandbox_network()
            && (self.mode != Access::ReadOnly || !self.writable_roots.is_empty())
            && (self.network_access || !self.writable_roots.is_empty())
        {
            // 只读的网络开关不走 sandbox_workspace_write（服务端会忽略）。
            // 额外目录在 workspace-write 上会进入 writableRoots。
            let network = self.network_access && self.mode != Access::ReadOnly;
            value["config"] = json!({
                "sandbox_workspace_write": {
                    "network_access": network,
                    "writable_roots": self.writable_roots,
                }
            });
        }
        value
    }

    /// `turn/start` 里除 threadId / input 以外的权限字段。
    pub(super) fn turn_permissions(&self, wire: SandboxWire) -> Value {
        if self.profile_active(wire) {
            let mut value = json!({
                "approvalPolicy": "on-request",
                "permissions": self.profile_id,
            });
            self.attach_reviewer(&mut value, wire);
            return value;
        }
        let mut value = json!({
            "approvalPolicy": self.mode.approval_policy(),
            "sandboxPolicy": self.sandbox_policy(),
        });
        self.attach_reviewer(&mut value, wire);
        value
    }

    fn profile_active(&self, wire: SandboxWire) -> bool {
        wire.profiles && !self.profile_id.is_empty()
    }

    fn attach_reviewer(&self, value: &mut Value, wire: SandboxWire) {
        if wire.reviewer {
            value["approvalsReviewer"] = json!(self.reviewer());
        }
    }

    pub(super) fn sandbox_policy(&self) -> Value {
        match self.mode {
            Access::Full => json!({ "type": "dangerFullAccess" }),
            Access::Ask => json!({
                "type": "workspaceWrite",
                "writableRoots": self.writable_roots,
                "networkAccess": self.network_access,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            }),
            Access::ReadOnly => json!({
                "type": "readOnly",
                "networkAccess": self.network_access,
            }),
        }
    }

    pub(super) fn summary(&self, wire: SandboxWire) -> String {
        if self.profile_active(wire) {
            return format!(
                "权限已设为自定义配置档 {}（permissions / reviewer {}）。下一条消息起生效。",
                self.profile_id,
                self.reviewer()
            );
        }
        let network = if self.uses_sandbox_network() {
            if self.network_access {
                "开"
            } else {
                "关"
            }
        } else {
            "不适用"
        };
        let roots = if self.writable_roots.is_empty() || !self.uses_sandbox_network() {
            "无".to_string()
        } else {
            self.writable_roots.join("、")
        };
        format!(
            "权限已设为{}（sandbox {} / approval {} / reviewer {} / 网络{} / 其他可写目录：{}）。下一条消息起生效。",
            self.label(),
            self.mode.sandbox_mode(),
            self.mode.approval_policy(),
            self.reviewer(),
            network,
            roots,
        )
    }
}

pub(super) fn is_approve_for_me(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "approve-for-me" | "approve_for_me" | "auto-review" | "auto_review" | "替我批准"
    )
}

/// `--add-dir`：绝对路径、去重、去掉工作区本身。
pub(super) fn normalize_writable_roots(cwd: &str, roots: &[String]) -> Vec<String> {
    let cwd_key = path_key(cwd);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        let trimmed = root.trim();
        if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
            continue;
        }
        let display = strip_verbatim_prefix(trimmed);
        let key = path_key(&display);
        if key.is_empty() || key == cwd_key || !seen.insert(key) {
            continue;
        }
        out.push(display);
    }
    out
}

fn path_key(path: &str) -> String {
    strip_verbatim_prefix(path)
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// `config/read` 的结果。键存在即表示这版 app-server 认得该能力；值为 null 表示用户没配。
pub(super) fn parse_permission_menu(value: &Value) -> PermissionMenu {
    let config = value.get("config").unwrap_or(value);
    let permission_profiles = config.get("permissions").is_some();
    let approve_for_me = config.get("approvals_reviewer").is_some();
    let network_access = config.get("sandbox_workspace_write").is_some();
    let profiles = match config.get("permissions") {
        Some(Value::Object(map)) => map
            .iter()
            .filter(|(id, _)| !id.starts_with(':'))
            .map(|(id, body)| PermissionProfileOption {
                id: id.clone(),
                label: id.clone(),
                description: body
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
            .collect(),
        _ => Vec::new(),
    };
    PermissionMenu {
        network_access,
        writable_roots: network_access,
        permission_profiles,
        approve_for_me,
        profiles,
    }
}

pub(super) fn merge_json(target: &mut Value, extra: Value) {
    let Some(extra) = extra.as_object() else {
        return;
    };
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for (key, value) in extra {
        target.insert(key.clone(), value.clone());
    }
}

impl Shared {
    pub(super) async fn ensure_wire(&self) {
        if self.wire_ready.load(Ordering::SeqCst) {
            return;
        }
        if self.refresh_sandbox_features().await.is_ok() {
            self.wire_ready.store(true, Ordering::SeqCst);
        }
    }

    pub(super) async fn refresh_sandbox_features(&self) -> Result<PermissionMenu, AgentError> {
        let value = self.request("config/read", json!({})).await?;
        let menu = parse_permission_menu(&value);
        *self.wire.lock().unwrap() = SandboxWire {
            reviewer: menu.approve_for_me,
            profiles: menu.permission_profiles,
        };
        self.wire_ready.store(true, Ordering::SeqCst);
        Ok(menu)
    }
}

pub(super) fn require_supported(
    choice: &SandboxChoice,
    wire: SandboxWire,
    ready: bool,
) -> Result<(), AgentError> {
    if !ready {
        return Ok(());
    }
    if !choice.profile_id.is_empty() && !wire.profiles {
        return Err(AgentError::Runtime(
            "当前 Codex app-server 不支持权限配置档".into(),
        ));
    }
    if choice.approve_for_me && !wire.reviewer {
        return Err(AgentError::Runtime(
            "当前 Codex app-server 不支持替我批准".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ask_maps_workspace_write_with_network_and_add_dir() {
        let choice = SandboxChoice::from_parts(
            "询问批准",
            true,
            &[
                r"C:\work\extra".into(),
                r"C:\work\repo".into(),
                r"C:\work\extra".into(),
                "relative".into(),
            ],
            "",
            r"C:\work\repo",
        )
        .unwrap();
        assert_eq!(choice.mode, Access::Ask);
        assert!(!choice.approve_for_me);
        assert_eq!(choice.writable_roots, vec![r"C:\work\extra"]);
        let thread = choice.thread_permissions(SandboxWire {
            reviewer: true,
            profiles: true,
        });
        assert_eq!(thread["sandbox"], "workspace-write");
        assert_eq!(thread["approvalPolicy"], "on-request");
        assert_eq!(thread["approvalsReviewer"], "user");
        assert_eq!(
            thread["config"]["sandbox_workspace_write"]["network_access"],
            true
        );
        assert_eq!(
            thread["config"]["sandbox_workspace_write"]["writable_roots"][0],
            r"C:\work\extra"
        );
        let turn = choice.turn_permissions(SandboxWire::default());
        assert!(turn.get("approvalsReviewer").is_none());
        assert_eq!(turn["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(turn["sandboxPolicy"]["networkAccess"], true);
        assert_eq!(turn["sandboxPolicy"]["writableRoots"][0], r"C:\work\extra");
    }

    #[test]
    fn approve_for_me_keeps_workspace_write_and_auto_review() {
        let mut choice = SandboxChoice::from_parts("只读", true, &[], "", r"C:\work").unwrap();
        assert!(choice.apply_preset("替我批准"));
        assert!(choice.network_access);
        assert_eq!(choice.mode, Access::Ask);
        let turn = choice.turn_permissions(SandboxWire {
            reviewer: true,
            profiles: false,
        });
        assert_eq!(turn["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(turn["sandboxPolicy"]["networkAccess"], true);
        assert_eq!(turn["approvalPolicy"], "on-request");
        assert_eq!(turn["approvalsReviewer"], "auto_review");
        assert!(turn.get("permissions").is_none());
    }

    #[test]
    fn read_only_network_stays_on_turn_policy() {
        let choice = SandboxChoice::from_parts("read-only", true, &[], "", r"C:\work").unwrap();
        let thread = choice.thread_permissions(SandboxWire {
            reviewer: true,
            profiles: true,
        });
        assert_eq!(thread["sandbox"], "read-only");
        assert!(thread.get("config").is_none());
        let turn = choice.turn_permissions(SandboxWire::default());
        assert_eq!(turn["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(turn["sandboxPolicy"]["networkAccess"], true);
        assert!(turn["sandboxPolicy"].get("writableRoots").is_none());
    }

    #[test]
    fn full_access_drops_network_and_reviewer_stays_user() {
        let choice = SandboxChoice::from_parts(
            "完全访问",
            true,
            &[r"D:\other".into()],
            "",
            r"C:\work",
        )
        .unwrap();
        assert!(!choice.network_access);
        assert!(choice.writable_roots.is_empty());
        let turn = choice.turn_permissions(SandboxWire {
            reviewer: true,
            profiles: true,
        });
        assert_eq!(turn["sandboxPolicy"]["type"], "dangerFullAccess");
        assert_eq!(turn["approvalPolicy"], "never");
        assert_eq!(turn["approvalsReviewer"], "user");
        assert!(turn.get("permissions").is_none());
    }

    #[test]
    fn named_profile_omits_sandbox() {
        let choice = SandboxChoice::from_parts(
            "ask",
            true,
            &[r"D:\other".into()],
            "project-edit",
            r"C:\work",
        )
        .unwrap();
        let wire = SandboxWire {
            reviewer: true,
            profiles: true,
        };
        let thread = choice.thread_permissions(wire);
        assert!(thread.get("sandbox").is_none());
        assert!(thread.get("config").is_none());
        assert_eq!(thread["permissions"], "project-edit");
        let turn = choice.turn_permissions(wire);
        assert!(turn.get("sandboxPolicy").is_none());
        assert_eq!(turn["permissions"], "project-edit");
        assert!(require_supported(&choice, SandboxWire::default(), true).is_err());
        assert!(require_supported(&choice, SandboxWire::default(), false).is_ok());
    }

    #[test]
    fn config_read_nulls_mean_supported_but_no_custom_profiles() {
        let menu = parse_permission_menu(&json!({
            "config": {
                "permissions": null,
                "approvals_reviewer": null,
                "sandbox_workspace_write": null
            }
        }));
        assert!(menu.permission_profiles);
        assert!(menu.approve_for_me);
        assert!(menu.network_access);
        assert!(menu.writable_roots);
        assert!(menu.profiles.is_empty());
    }

    #[test]
    fn config_read_lists_named_profiles_and_hides_builtins() {
        let menu = parse_permission_menu(&json!({
            "permissions": {
                ":workspace": { "description": "built-in" },
                "project-edit": { "description": "Uses permissions defined in config.toml" }
            },
            "approvals_reviewer": "user"
        }));
        assert_eq!(menu.profiles.len(), 1);
        assert_eq!(menu.profiles[0].id, "project-edit");
        assert_eq!(
            menu.profiles[0].description,
            "Uses permissions defined in config.toml"
        );
    }

    #[test]
    fn old_config_without_keys_hides_optional_modes() {
        let menu = parse_permission_menu(&json!({ "config": { "model": "gpt" } }));
        assert!(!menu.permission_profiles);
        assert!(!menu.approve_for_me);
        assert!(!menu.network_access);
    }
}
