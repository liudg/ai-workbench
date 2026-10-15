//! Claude Code 的启动参数。直接 `Command::new` 拉起二进制，不经 shell。
//!
//! 参数顺序对齐官方 Python SDK
//! `claude_agent_sdk/_internal/transport/subprocess_cli.py` `_build_command`：
//! `--output-format stream-json --verbose`（约 L574）、
//! `--model`（L622）、`--permission-prompt-tool`（L633）、
//! `--permission-mode`（L636）、`--resume=` / `--session-id=` 等号形式（L642–655）、
//! `--include-partial-messages`（L695）、`--setting-sources=`（L730）、
//! `--effort`（L777）、`--input-format stream-json`（L793）。
//!
//! 不传 `--system-prompt ""`。SDK 在 `system_prompt is None` 时会清空 CLI 自己的提示词
//! （subprocess_cli.py L576–577）。工作台要留着 CLI 的提示词。
//!
//! `--print`：CLI `main.tsx` 把 `-p` 或非 TTY 的 stdout 当成 headless（约 L797–812）。
//! stream-json / `--include-partial-messages` 的帮助文字要求 `--print`
//! （`cli/print.ts` 在 `--print` 下还要求 `--verbose`）。Python SDK 不写 `--print`，
//! 只靠管道 stdout 不是 TTY。这里显式写上，避免宿主碰巧有 TTY 时掉进交互模式。
//!
//! `--allow-dangerously-skip-permissions`：`utils/permissions/permissionSetup.ts`
//! `initializeToolPermissionContext`（约 L939–944）里，
//! `isBypassPermissionsModeAvailable` 仅在初始模式已是 `bypassPermissions`，
//! 或进程带了这个旗标时为真。没有它，之后 `set_permission_mode` 切到
//! `bypassPermissions` 会被拒绝（`cli/print.ts` `handleSetPermissionMode`）。
//! 这个旗标不会把会话默认设成跳过权限（`main.tsx` 的选项说明）。
//! 完全访问另外传 `--permission-mode bypassPermissions`。

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

/// 一次启动要写进 argv 的选择。模型名和推理强度只在调用方已经从 CLI 拿到时才填。
pub struct Launch {
    pub session_id: String,
    pub resume: bool,
    pub permission_mode: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// 启动时的 `--add-dir`。运行中没有对应的控制请求。
    pub writable_roots: Vec<String>,
}

pub fn cli_args(launch: &Launch) -> Vec<String> {
    let mut cmd = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
    if let Some(model) = nonempty(launch.model.as_deref()) {
        cmd.push("--model".to_string());
        cmd.push(model.to_string());
    }
    cmd.extend([
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
        "--permission-mode".to_string(),
        launch.permission_mode.clone(),
    ]);
    // 等号形式：CLI 把 `--resume` 声明成可选值，两段式会把以 `-` 开头的值当成另一个旗标
    // （subprocess_cli.py L642–655）。
    if launch.resume {
        cmd.push(format!("--resume={}", launch.session_id));
    } else {
        cmd.push(format!("--session-id={}", launch.session_id));
    }
    cmd.push("--include-partial-messages".to_string());
    cmd.push("--setting-sources=user,project".to_string());
    if let Some(effort) = nonempty(launch.effort.as_deref()) {
        cmd.push("--effort".to_string());
        cmd.push(effort.to_string());
    }
    cmd.push("--allow-dangerously-skip-permissions".to_string());
    for dir in &launch.writable_roots {
        cmd.push("--add-dir".to_string());
        cmd.push(dir.clone());
    }
    cmd.extend(["--input-format".to_string(), "stream-json".to_string()]);
    cmd
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|item| !item.is_empty())
}

/// 工作台档位 → CLI `PermissionMode`。
/// `full` → `bypassPermissions`，`ask` → `default`。
/// 只读和替我批准启动时用 `default`。
pub fn permission_mode_for_access(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("full") {
        "full" => "bypassPermissions",
        "plan" => "plan",
        _ => "default",
    }
}

pub fn access_to_permission_mode(
    mode: &str,
) -> Result<&'static str, crate::features::agents::AgentError> {
    match mode {
        "full" => Ok("bypassPermissions"),
        "ask" | "default" => Ok("default"),
        "plan" => Ok("plan"),
        "read-only" | "approve-for-me" => Err(crate::features::agents::AgentError::Runtime(
            "不支持这个权限档位".into(),
        )),
        _ => Err(crate::features::agents::AgentError::Runtime(format!(
            "不认识的权限档位 {mode}"
        ))),
    }
}

pub fn roots_from_options(options: &Value) -> Vec<String> {
    options
        .get("writable_roots")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// `--add-dir`：绝对路径、去重、去掉工作区本身。比较时忽略大小写和斜杠方向。
pub fn normalize_add_dirs(cwd: &str, roots: &[String]) -> Vec<String> {
    let cwd_path = Path::new(cwd.trim());
    let cwd_key = path_key(&cwd_path.to_string_lossy());
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd_path.join(path)
        };
        let display = absolute.to_string_lossy().to_string();
        let key = path_key(&display);
        if key.is_empty() || (!cwd_key.is_empty() && key == cwd_key) || !seen.insert(key) {
            continue;
        }
        out.push(display);
    }
    out.sort_by(|left, right| path_key(left).cmp(&path_key(right)));
    out
}

fn path_key(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}
