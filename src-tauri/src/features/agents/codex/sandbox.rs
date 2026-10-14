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

    /// TUI `approval_preset_actions` 的提示：`Permissions updated to {label}`。
    pub(super) fn summary(&self) -> String {
        format!("Permissions updated to {}", self.official_label())
    }

    /// `status/card.rs::status_permissions_label` + `status_approval_label`。
    /// 自定义配置档的沙箱摘要要靠核心 `summarize_permission_profile`，这里拿不到，只显示 id 和审批。
    pub(super) fn status_label(&self) -> String {
        let approval = match (self.mode, self.approve_for_me) {
            (Access::Full, _) => "never",
            (_, true) => "Approve for me",
            _ => "Ask for approval",
        };
        if !self.profile_id.is_empty() {
            return format!("Profile {} ({approval})", self.profile_id);
        }
        let network = self.network_access;
        let suffix = if self.writable_roots.is_empty() {
            String::new()
        } else {
            format!(" [{}]", self.writable_roots.join(", "))
        };
        match self.mode {
            Access::Full => "Full Access".to_string(),
            Access::ReadOnly if network => format!("Read Only with network access ({approval})"),
            Access::ReadOnly => format!("Read Only ({approval})"),
            Access::Ask if network => format!("Workspace with network access{suffix} ({approval})"),
            Access::Ask => format!("Workspace{suffix} ({approval})"),
        }
    }

    pub(super) fn official_label(&self) -> String {
        if !self.profile_id.is_empty() {
            return self.profile_id.clone();
        }
        let mode = if self.approve_for_me {
            "approve-for-me"
        } else {
            match self.mode {
                Access::Full => "full",
                Access::Ask => "ask",
                Access::ReadOnly => "read-only",
            }
        };
        preset_label(mode).unwrap_or(mode).to_string()
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
        if trimmed.is_empty() || !is_absolute_input(trimmed) {
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

/// 盘符和 UNC 在非 Windows 宿主上也是绝对路径。`std::path` 只认当前系统的写法。
fn is_absolute_input(path: &str) -> bool {
    let path = strip_verbatim_prefix(path.trim());
    if Path::new(&path).is_absolute() {
        return true;
    }
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\'))
        || path.starts_with(r"\\")
}

/// TUI `/permissions` 菜单（`permissions_menu.rs::open_permission_profiles_popup`）。
pub(super) const MENU_TITLE: &str = "Update Model Permissions";
const NO_PROFILES: &str = "No permission profiles returned by the server.";
const NOT_AVAILABLE: &str = "Not available on this server";
const DISABLED_BY_REQUIREMENTS: &str = "Disabled by requirements";
const CONFIGURED_PROFILE: &str = "Configured permission profile";
const UNSUPPORTED_DISCOVERY: &str =
    "This server does not support permission discovery. Upgrade the Codex server to use this menu.";
const PAGINATION_LIMIT: &str =
    "Permission discovery exceeded its pagination limit. Try /permissions again.";
const DUPLICATE_PROFILES: &str = "The server returned duplicate permission profiles.";

/// 四个内置档位。标签与说明取自 `chatwidget.rs` 常量和 `permission_preset_description`，
/// 档位对应 `utils/approval-presets::builtin_approval_presets` 的 approval 与内置配置档。
struct PresetSpec {
    mode: &'static str,
    profile: &'static str,
    label: &'static str,
    description: &'static str,
    approval: &'static str,
    reviewer: &'static str,
}

const PRESETS: [PresetSpec; 4] = [
    PresetSpec {
        mode: "ask",
        profile: ":workspace",
        label: "Ask for approval",
        description: "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace",
        approval: "on-request",
        reviewer: "user",
    },
    PresetSpec {
        mode: "approve-for-me",
        profile: ":workspace",
        label: "Approve for me",
        description: "Only ask for actions detected as potentially unsafe",
        approval: "on-request",
        reviewer: "auto_review",
    },
    PresetSpec {
        mode: "full",
        profile: ":danger-full-access",
        label: "Full Access",
        description: "Use with caution: Codex can edit files outside this workspace and access the internet without approval",
        approval: "never",
        reviewer: "user",
    },
    PresetSpec {
        mode: "read-only",
        profile: ":read-only",
        label: "Read Only",
        description: "Read workspace files, with approval required for edits or internet access",
        approval: "on-request",
        reviewer: "user",
    },
];

/// 按档位 id 取官方标签。权限摘要和 /permissions 选择卡也用它。
pub(super) fn preset_label(mode: &str) -> Option<&'static str> {
    PRESETS.iter().find(|spec| spec.mode == mode).map(|spec| spec.label)
}

#[derive(Debug, Clone)]
pub(super) struct ProfileSummary {
    pub id: String,
    pub description: Option<String>,
    pub allowed: bool,
}

/// `permissionProfile/list` 与 `configRequirements/read` 的结果。
#[derive(Debug, Clone)]
pub(super) struct Discovery {
    pub profiles: Vec<ProfileSummary>,
    pub requirements: Value,
}

impl Discovery {
    /// `permission_discovery.rs::PermissionDiscovery::disabled_reason`。
    fn disabled_reason(&self, id: &str, approval: Option<&str>, reviewer: Option<&str>) -> Option<String> {
        let Some(profile) = self.profiles.iter().find(|profile| profile.id == id) else {
            return Some(NOT_AVAILABLE.into());
        };
        let req = &self.requirements;
        let profile_blocked = req
            .get("allowedPermissionProfiles")
            .and_then(Value::as_object)
            .is_some_and(|allowed| allowed.get(id).and_then(Value::as_bool) != Some(true));
        let listed_blocked = |key: &str, value: Option<&str>| {
            req.get(key).and_then(Value::as_array).is_some_and(|allowed| {
                value.is_some_and(|value| !allowed.iter().any(|item| item.as_str() == Some(value)))
            })
        };
        if !profile.allowed
            || profile_blocked
            || listed_blocked("allowedApprovalPolicies", approval)
            || listed_blocked("allowedApprovalsReviewers", reviewer)
        {
            return Some(DISABLED_BY_REQUIREMENTS.into());
        }
        None
    }
}

pub(super) fn parse_profile_page(value: &Value) -> (Vec<ProfileSummary>, Option<String>) {
    let profiles = value
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    Some(ProfileSummary {
                        id: item.get("id").and_then(Value::as_str)?.to_string(),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        allowed: item.get("allowed").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let next = value
        .get("nextCursor")
        .and_then(Value::as_str)
        .map(str::to_string);
    (profiles, next)
}

/// `permission_discovery.rs::discovery_error`。
pub(super) fn discovery_error(code: Option<i64>, message: &str) -> String {
    let unsupported = code == Some(-32601)
        || (code == Some(-32600)
            && (message.contains("permissionProfile/list")
                || message.contains("configRequirements/read")
                || message.contains("config/read")));
    if unsupported {
        UNSUPPORTED_DISCOVERY.into()
    } else {
        format!("Failed to load permissions: {message}")
    }
}

/// `experimentalFeature/list` 里 `guardian_approval` 是否启用（TUI 用同一开关决定显示替我批准）。
pub(super) fn feature_enabled(pages: &[Value], name: &str) -> bool {
    pages.iter().any(|page| {
        page.get("data").and_then(Value::as_array).is_some_and(|list| {
            list.iter().any(|item| {
                item.get("name").and_then(Value::as_str) == Some(name)
                    && item.get("enabled").and_then(Value::as_bool) == Some(true)
            })
        })
    })
}

pub(super) fn build_menu(
    discovery: Result<Discovery, String>,
    approve_for_me: bool,
    network_access: bool,
) -> PermissionMenu {
    let discovery = match discovery {
        Ok(discovery) => discovery,
        Err(notice) => {
            return PermissionMenu {
                network_access,
                writable_roots: network_access,
                permission_profiles: false,
                approve_for_me: false,
                title: MENU_TITLE.into(),
                notice: Some(notice),
                presets: Vec::new(),
                profiles: Vec::new(),
            }
        }
    };
    let presets = PRESETS
        .iter()
        .filter(|spec| spec.mode != "approve-for-me" || approve_for_me)
        .map(|spec| PermissionProfileOption {
            id: spec.mode.into(),
            label: spec.label.into(),
            description: spec.description.into(),
            disabled_reason: discovery.disabled_reason(
                spec.profile,
                Some(spec.approval),
                Some(spec.reviewer),
            ),
        })
        .collect();
    let profiles = discovery
        .profiles
        .iter()
        .filter(|profile| !profile.id.starts_with(':'))
        .map(|profile| PermissionProfileOption {
            id: profile.id.clone(),
            label: profile.id.clone(),
            description: profile
                .description
                .clone()
                .unwrap_or_else(|| CONFIGURED_PROFILE.into()),
            disabled_reason: discovery.disabled_reason(&profile.id, None, None),
        })
        .collect();
    let empty = discovery.profiles.is_empty();
    PermissionMenu {
        network_access,
        writable_roots: network_access,
        permission_profiles: true,
        approve_for_me,
        title: MENU_TITLE.into(),
        notice: empty.then(|| NO_PROFILES.into()),
        presets: if empty { Vec::new() } else { presets },
        profiles: if empty { Vec::new() } else { profiles },
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

    /// 权限配置档来自 `permissionProfile/list`，替我批准看 `guardian_approval` 功能开关。
    /// 网络与额外可写目录是工作台对 `sandbox_workspace_write` 的扩展，仍看 `config/read` 有没有这个键。
    pub(super) async fn refresh_sandbox_features(&self) -> Result<PermissionMenu, AgentError> {
        let discovery = self.discover_permissions().await;
        let features = self.feature_pages().await;
        let approve_for_me = feature_enabled(&features, "guardian_approval");
        let network_access = match self.request("config/read", json!({})).await {
            Ok(value) => value
                .get("config")
                .unwrap_or(&value)
                .get("sandbox_workspace_write")
                .is_some(),
            Err(_) => false,
        };
        let menu = build_menu(discovery, approve_for_me, network_access);
        *self.wire.lock().unwrap() = SandboxWire {
            reviewer: menu.approve_for_me,
            profiles: menu.permission_profiles,
        };
        self.wire_ready.store(true, Ordering::SeqCst);
        Ok(menu)
    }

    async fn discover_permissions(&self) -> Result<Discovery, String> {
        let requirements = self
            .request_raw("configRequirements/read", Value::Null)
            .await
            .map_err(|(code, message)| discovery_error(code, &message))?;
        let mut profiles: Vec<ProfileSummary> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut cursors = HashSet::new();
        for _ in 0..10 {
            let page = self
                .request_raw(
                    "permissionProfile/list",
                    json!({ "cursor": cursor, "limit": 100, "cwd": self.cwd }),
                )
                .await
                .map_err(|(code, message)| discovery_error(code, &message))?;
            let (data, next) = parse_profile_page(&page);
            if data.len() > 100 {
                break;
            }
            profiles.extend(data);
            cursor = next;
            let Some(next) = cursor.clone() else {
                let mut ids = HashSet::new();
                if !profiles.iter().all(|profile| ids.insert(profile.id.clone())) {
                    return Err(DUPLICATE_PROFILES.into());
                }
                return Ok(Discovery {
                    profiles,
                    requirements: requirements
                        .get("requirements")
                        .cloned()
                        .unwrap_or(Value::Null),
                });
            };
            if !cursors.insert(next) {
                break;
            }
        }
        Err(PAGINATION_LIMIT.into())
    }

    async fn feature_pages(&self) -> Vec<Value> {
        let mut pages = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..10 {
            let mut params = json!({ "cursor": cursor, "limit": 200 });
            if let Some(thread_id) = self.thread_id.lock().unwrap().clone() {
                params["threadId"] = json!(thread_id);
            }
            let Ok(page) = self.request("experimentalFeature/list", params).await else {
                break;
            };
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            pages.push(page);
            if cursor.is_none() {
                break;
            }
        }
        pages
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

    fn discovery(profiles: &[(&str, bool)], requirements: Value) -> Discovery {
        Discovery {
            profiles: profiles
                .iter()
                .map(|(id, allowed)| ProfileSummary {
                    id: id.to_string(),
                    description: None,
                    allowed: *allowed,
                })
                .collect(),
            requirements,
        }
    }

    #[test]
    fn menu_lists_official_presets_then_named_profiles() {
        let page = json!({
            "data": [
                { "id": ":read-only", "description": null, "allowed": true },
                { "id": ":workspace", "description": null, "allowed": true },
                { "id": ":danger-full-access", "description": null, "allowed": true },
                { "id": "project-edit", "description": "Edit only this project", "allowed": true },
                { "id": "locked", "description": null, "allowed": false }
            ],
            "nextCursor": null
        });
        let (profiles, next) = parse_profile_page(&page);
        assert!(next.is_none());
        let menu = build_menu(
            Ok(Discovery {
                profiles,
                requirements: Value::Null,
            }),
            true,
            true,
        );
        assert_eq!(menu.title, "Update Model Permissions");
        let labels: Vec<_> = menu.presets.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Ask for approval", "Approve for me", "Full Access", "Read Only"]
        );
        assert!(menu.presets.iter().all(|item| item.disabled_reason.is_none()));
        assert_eq!(menu.profiles.len(), 2);
        assert_eq!(menu.profiles[0].description, "Edit only this project");
        assert_eq!(menu.profiles[1].description, "Configured permission profile");
        assert_eq!(
            menu.profiles[1].disabled_reason.as_deref(),
            Some("Disabled by requirements")
        );
        assert!(menu.permission_profiles && menu.approve_for_me);
    }

    #[test]
    fn approve_for_me_follows_the_guardian_feature() {
        let pages = vec![json!({ "data": [{ "name": "guardian_approval", "enabled": false }] })];
        assert!(!feature_enabled(&pages, "guardian_approval"));
        let menu = build_menu(Ok(discovery(&[(":workspace", true)], Value::Null)), false, false);
        assert!(menu.presets.iter().all(|item| item.id != "approve-for-me"));
        let missing = menu.presets.iter().find(|item| item.id == "full").unwrap();
        assert_eq!(missing.disabled_reason.as_deref(), Some("Not available on this server"));
    }

    #[test]
    fn requirements_disable_presets() {
        let menu = build_menu(
            Ok(discovery(
                &[(":workspace", true), (":danger-full-access", true), (":read-only", true)],
                json!({ "allowedApprovalPolicies": ["on-request"], "allowedApprovalsReviewers": ["user"] }),
            )),
            true,
            false,
        );
        let reason = |id: &str| {
            menu.presets
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.disabled_reason.clone())
        };
        assert_eq!(reason("full").as_deref(), Some("Disabled by requirements"));
        assert_eq!(reason("approve-for-me").as_deref(), Some("Disabled by requirements"));
        assert!(reason("ask").is_none());
    }

    #[test]
    fn empty_or_failed_discovery_shows_the_official_notice() {
        let empty = build_menu(Ok(discovery(&[], Value::Null)), true, true);
        assert!(empty.presets.is_empty());
        assert_eq!(
            empty.notice.as_deref(),
            Some("No permission profiles returned by the server.")
        );
        assert_eq!(
            discovery_error(Some(-32601), "method not found"),
            "This server does not support permission discovery. Upgrade the Codex server to use this menu."
        );
        assert_eq!(
            discovery_error(Some(-32603), "boom"),
            "Failed to load permissions: boom"
        );
        let failed = build_menu(Err("Failed to load permissions: boom".into()), true, true);
        assert!(!failed.permission_profiles);
        assert_eq!(failed.notice.as_deref(), Some("Failed to load permissions: boom"));
    }
}
