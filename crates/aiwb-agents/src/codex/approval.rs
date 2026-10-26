//! Codex 桌面端审批卡的请求文案和 app-server 回包。
//!
//! 选项、标题和决策形状来自安装包
//! `webview/assets/pending-request-item-panel-a592e84fd27e.js` 的 `qr` / `sr`，
//! 以及 `app-shared` 里导出为 `V6` 的命令前缀格式化（`WSr`）。
//! 统计开关和线程详情档位的隐藏条件没有观察到具体取值，不在这里实现。

use serde_json::{json, Value};

use aiwb_core::models::PromptOption;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ApprovalReplyKind {
    Command,
    File,
    Permissions,
}

#[derive(Clone, Debug)]
pub(super) struct ApprovalReply {
    pub(super) kind: ApprovalReplyKind,
    pub(super) execpolicy: Option<Vec<String>>,
    pub(super) network_amendment: Option<Value>,
    pub(super) permissions: Value,
}

pub(super) struct ApprovalPrompt {
    pub(super) header: String,
    pub(super) question: String,
    pub(super) subtitle: String,
    pub(super) body: String,
    pub(super) body_kind: String,
    pub(super) reason: String,
    pub(super) options: Vec<PromptOption>,
    pub(super) reply: ApprovalReply,
}

pub(super) enum ApprovalFromRequest {
    Prompt(ApprovalPrompt),
    /// 权限明细为空时桌面端不展示卡片，直接按拒绝回包。
    AutoDeny(Value),
}

/// 实机 `item/fileChange/requestApproval` 只有 itemId。变更在先到的 fileChange item 上。
pub(super) fn merge_file_changes(params: &Value, item: Option<&Value>) -> Value {
    if params.get("changes").is_some() {
        return params.clone();
    }
    let Some(changes) = item.and_then(|item| item.get("changes")) else {
        return params.clone();
    };
    let mut merged = params.clone();
    if let Value::Object(map) = &mut merged {
        map.insert("changes".to_string(), changes.clone());
    }
    merged
}

pub(super) fn approval_from_request(method: &str, params: &Value) -> ApprovalFromRequest {
    match method {
        "item/fileChange/requestApproval" => ApprovalFromRequest::Prompt(file_prompt(params)),
        "item/permissions/requestApproval" => permissions_prompt(params),
        _ => ApprovalFromRequest::Prompt(command_prompt(params)),
    }
}

pub(super) fn approval_result(reply: &ApprovalReply, choice: &str) -> Result<Value, String> {
    let choice = normalize_choice(choice);
    match reply.kind {
        ApprovalReplyKind::Command => {
            let decision = command_decision(choice, reply)?;
            Ok(json!({ "decision": decision }))
        }
        ApprovalReplyKind::File => Ok(json!({ "decision": file_decision(choice)? })),
        ApprovalReplyKind::Permissions => Ok(permissions_response(choice, reply)?),
    }
}

fn command_prompt(params: &Value) -> ApprovalPrompt {
    let network = network_context(params);
    let execpolicy = params
        .get("proposedExecpolicyAmendment")
        .and_then(execpolicy_tokens);
    let network_amendment = allow_network_amendment(params);
    let reason = text_field(params, "reason");
    let body = command_body(params, execpolicy.as_deref());
    let (header, question, subtitle, shown_body) = if let Some(network) = network.as_ref() {
        (
            "互联网访问".to_string(),
            format!("允许 ChatGPT 与 {} 建立连接？", network.destination),
            format!("{} 不在当前网络允许列表中", network.host),
            String::new(),
        )
    } else if !reason.is_empty() {
        ("终端".to_string(), reason.clone(), String::new(), body.clone())
    } else {
        (
            "终端".to_string(),
            "允许 ChatGPT 运行此命令？".to_string(),
            String::new(),
            body.clone(),
        )
    };
    let mut options = vec![allow_once(), deny()];
    if network.is_some() {
        if network_amendment.is_some() {
            options.insert(0, leading("applyNetworkPolicyAmendment", "始终允许", ""));
        }
        options.push(scoped("acceptForSession", "允许此对话", ""));
    } else if execpolicy.as_ref().is_some_and(|tokens| !tokens.is_empty()) {
        let prefix = command_prefix(execpolicy.as_deref().unwrap_or(&[]));
        options.push(scoped(
            "acceptWithExecpolicyAmendment",
            "允许类似命令",
            &format!("允许在此对话中使用以 {prefix} 开头的命令"),
        ));
    }
    ApprovalPrompt {
        header,
        question,
        subtitle,
        body: shown_body,
        body_kind: if network.is_some() || body.is_empty() {
            String::new()
        } else {
            "command".into()
        },
        reason: String::new(),
        options,
        reply: ApprovalReply {
            kind: ApprovalReplyKind::Command,
            execpolicy,
            network_amendment,
            permissions: Value::Null,
        },
    }
}

fn file_prompt(params: &Value) -> ApprovalPrompt {
    let body = file_body(params);
    ApprovalPrompt {
        header: "编辑文件".into(),
        question: "是否允许 ChatGPT 编辑以下文件？".into(),
        subtitle: String::new(),
        body_kind: if body.is_empty() {
            String::new()
        } else {
            "files".into()
        },
        body,
        reason: String::new(),
        options: vec![
            allow_once(),
            deny(),
            scoped(
                "acceptForSession",
                "允许所有修改",
                "允许在此对话中进行本次及后续文件编辑，无需再次询问",
            ),
        ],
        reply: ApprovalReply {
            kind: ApprovalReplyKind::File,
            execpolicy: None,
            network_amendment: None,
            permissions: Value::Null,
        },
    }
}

fn permissions_prompt(params: &Value) -> ApprovalFromRequest {
    let permissions = params
        .get("permissions")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let details = permission_details(&permissions);
    if details.is_empty() {
        return ApprovalFromRequest::AutoDeny(json!({ "permissions": {}, "scope": "turn" }));
    }
    let network_only = details.len() == 1 && matches!(details[0], PermissionDetail::Network);
    let question = permission_title(&details);
    let reason = text_field(params, "reason");
    ApprovalFromRequest::Prompt(ApprovalPrompt {
        header: if network_only {
            "互联网访问".into()
        } else {
            "权限".into()
        },
        question,
        subtitle: reason,
        body: String::new(),
        body_kind: String::new(),
        reason: String::new(),
        options: vec![
            allow_once(),
            deny(),
            scoped("acceptForSession", "允许此对话", ""),
        ],
        reply: ApprovalReply {
            kind: ApprovalReplyKind::Permissions,
            execpolicy: None,
            network_amendment: None,
            permissions,
        },
    })
}

fn command_decision(choice: &str, reply: &ApprovalReply) -> Result<Value, String> {
    match choice {
        "accept" => Ok(json!("accept")),
        "acceptForSession" => Ok(json!("acceptForSession")),
        "acceptWithExecpolicyAmendment" => {
            let amendment = reply
                .execpolicy
                .as_ref()
                .filter(|tokens| !tokens.is_empty())
                .ok_or_else(|| "Missing exec policy amendment".to_string())?;
            Ok(json!({ "acceptWithExecpolicyAmendment": { "execpolicy_amendment": amendment } }))
        }
        "applyNetworkPolicyAmendment" => {
            let amendment = reply
                .network_amendment
                .as_ref()
                .ok_or_else(|| "Missing network policy amendment".to_string())?;
            Ok(json!({ "applyNetworkPolicyAmendment": { "network_policy_amendment": amendment } }))
        }
        "decline" => Ok(json!("decline")),
        other => Err(format!("Unknown exec approval decision: {other}")),
    }
}

fn file_decision(choice: &str) -> Result<Value, String> {
    match choice {
        "accept" | "acceptForSession" | "decline" => Ok(json!(choice)),
        other => Err(format!("Unknown file change approval decision: {other}")),
    }
}

fn permissions_response(choice: &str, reply: &ApprovalReply) -> Result<Value, String> {
    match choice {
        "decline" => Ok(json!({ "permissions": {}, "scope": "turn" })),
        "accept" => Ok(json!({
            "permissions": reply.permissions,
            "scope": "turn",
            "strictAutoReview": false
        })),
        "acceptForSession" => Ok(json!({
            "permissions": reply.permissions,
            "scope": "session",
            "strictAutoReview": false
        })),
        other => Err(format!("Unknown permission approval decision: {other}")),
    }
}

fn normalize_choice(choice: &str) -> &str {
    match choice.trim() {
        "approve" | "accept" | "allow" | "yes" | "y" | "允许" | "允许一次" => "accept",
        "reject" | "拒绝" => "decline",
        other => other,
    }
}

fn allow_once() -> PromptOption {
    option("accept", "允许一次", "primary", "")
}

fn deny() -> PromptOption {
    option("decline", "拒绝", "deny", "")
}

fn leading(id: &str, label: &str, tooltip: &str) -> PromptOption {
    option(id, label, "leading", tooltip)
}

fn scoped(id: &str, label: &str, tooltip: &str) -> PromptOption {
    option(id, label, "scoped", tooltip)
}

fn option(id: &str, label: &str, slot: &str, tooltip: &str) -> PromptOption {
    PromptOption {
        id: id.into(),
        label: label.into(),
        description: String::new(),
        slot: slot.into(),
        tooltip: tooltip.into(),
        ..Default::default()
    }
}

struct NetworkContext {
    host: String,
    destination: String,
}

fn network_context(params: &Value) -> Option<NetworkContext> {
    let context = params.get("networkApprovalContext")?;
    if context.is_null() {
        return None;
    }
    let host = text_field(context, "host");
    if host.is_empty() {
        return None;
    }
    let protocol = text_field(context, "protocol");
    let destination = if protocol == "http" || protocol == "https" {
        format!("{protocol}://{host}")
    } else {
        host.clone()
    };
    Some(NetworkContext { host, destination })
}

fn allow_network_amendment(params: &Value) -> Option<Value> {
    params
        .get("proposedNetworkPolicyAmendments")
        .and_then(Value::as_array)?
        .iter()
        .find(|item| item.get("action").and_then(Value::as_str) == Some("allow"))
        .cloned()
}

fn execpolicy_tokens(value: &Value) -> Option<Vec<String>> {
    let list = value.as_array()?;
    let mut tokens = Vec::with_capacity(list.len());
    for item in list {
        tokens.push(item.as_str()?.to_string());
    }
    let joined = tokens.join(" ");
    if joined.contains('\n') || joined.contains('\r') {
        return None;
    }
    Some(tokens)
}

fn command_prefix(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| shell_token(token))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `app-shared` 的 `GSr`。含 `` `$\\! `` 或引号时走 `xWn`，该函数体未观察到，原样保留 token。
fn shell_token(token: &str) -> String {
    let plain = token.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '@' | '+' | '=' | ':' | ',' | '.' | '/' | '-')
    });
    if plain {
        return token.to_string();
    }
    if !token.contains(['`', '$', '\\', '!']) && !token.contains('"') {
        return format!("\"{token}\"");
    }
    token.to_string()
}

fn command_body(params: &Value, execpolicy: Option<&[String]>) -> String {
    if let Some(actions) = params.get("commandActions").and_then(Value::as_array) {
        let commands: Vec<&str> = actions
            .iter()
            .filter_map(|action| action.get("command").and_then(Value::as_str))
            .filter(|command| !command.is_empty())
            .collect();
        if !commands.is_empty() {
            return commands.join(" ");
        }
    }
    let command = text_field(params, "command");
    if !command.is_empty() {
        return command;
    }
    execpolicy
        .filter(|tokens| !tokens.is_empty())
        .map(command_prefix)
        .unwrap_or_default()
}

fn file_body(params: &Value) -> String {
    let Some(changes) = params.get("changes") else {
        return String::new();
    };
    let mut lines = Vec::new();
    if let Some(map) = changes.as_object() {
        for (path, change) in map {
            push_file_line(&mut lines, path, change);
        }
    } else if let Some(list) = changes.as_array() {
        for change in list {
            let path = change
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if path.is_empty() {
                continue;
            }
            push_file_line(&mut lines, &path, change);
        }
    }
    lines.join("\n")
}

fn push_file_line(lines: &mut Vec<String>, path: &str, change: &Value) {
    let target = change
        .get("move_path")
        .or_else(|| change.get("movePath"))
        .and_then(Value::as_str)
        .filter(|target| !target.is_empty());
    if let Some(target) = target {
        lines.push(format!("{path} → {target}"));
    } else {
        lines.push(path.to_string());
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PermissionDetail {
    Network,
    Read(Vec<String>),
    Write(Vec<String>),
    ReadWrite(Vec<String>),
}

fn permission_details(permissions: &Value) -> Vec<PermissionDetail> {
    let mut details = Vec::new();
    if permissions.get("network").is_some_and(|value| !value.is_null()) {
        details.push(PermissionDetail::Network);
    }
    let Some(entries) = permissions
        .pointer("/fileSystem/entries")
        .and_then(Value::as_array)
    else {
        return details;
    };
    let mut reads = Vec::new();
    let mut writes = Vec::new();
    for entry in entries {
        let Some(path) = entry_path(entry.get("path").unwrap_or(&Value::Null)) else {
            continue;
        };
        match entry.get("access").and_then(Value::as_str) {
            Some("read") => reads.push(path),
            Some("write") => writes.push(path),
            _ => {}
        }
    }
    let both: Vec<String> = reads
        .iter()
        .filter(|path| writes.iter().any(|other| other == *path))
        .cloned()
        .collect();
    let read_only: Vec<String> = reads
        .into_iter()
        .filter(|path| !both.iter().any(|other| other == path))
        .collect();
    let write_only: Vec<String> = writes
        .into_iter()
        .filter(|path| !both.iter().any(|other| other == path))
        .collect();
    if !both.is_empty() {
        details.push(PermissionDetail::ReadWrite(both));
    }
    if !read_only.is_empty() {
        details.push(PermissionDetail::Read(read_only));
    }
    if !write_only.is_empty() {
        details.push(PermissionDetail::Write(write_only));
    }
    details
}

fn entry_path(path: &Value) -> Option<String> {
    match path.get("type").and_then(Value::as_str)? {
        "path" => nonempty(path.get("path")),
        "glob_pattern" => nonempty(path.get("pattern")),
        "special" => special_root(path.get("value").unwrap_or(&Value::Null)),
        _ => None,
    }
}

fn special_root(value: &Value) -> Option<String> {
    let text = match value.get("kind").and_then(Value::as_str)? {
        "root" => "/".to_string(),
        "minimal" => ":minimal".to_string(),
        "project_roots" => match nonempty(value.get("subpath")) {
            Some(subpath) => format!(":project_roots/{subpath}"),
            None => ":project_roots".to_string(),
        },
        "tmpdir" => ":tmpdir".to_string(),
        "slash_tmp" => "/tmp".to_string(),
        "unknown" => {
            let path = value.get("path").and_then(Value::as_str).unwrap_or("");
            match nonempty(value.get("subpath")) {
                Some(subpath) if !path.is_empty() => format!("{path}/{subpath}"),
                _ => path.to_string(),
            }
        }
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn permission_title(details: &[PermissionDetail]) -> String {
    if details.len() == 1 {
        return match &details[0] {
            PermissionDetail::Network => "允许 ChatGPT 连接互联网？".into(),
            PermissionDetail::Read(paths) => {
                format!("允许 ChatGPT 查看 {} 的内容吗？", conjunction(paths))
            }
            PermissionDetail::Write(paths) => {
                format!("允许 ChatGPT 编辑 {} 的内容吗？", conjunction(paths))
            }
            PermissionDetail::ReadWrite(paths) => {
                format!("允许 ChatGPT 查看和编辑 {} 的内容？", conjunction(paths))
            }
        };
    }
    let actions: Vec<String> = details
        .iter()
        .map(|detail| match detail {
            PermissionDetail::Network => "连接到互联网".to_string(),
            PermissionDetail::Read(paths) => format!("查看 {} 的内容", conjunction(paths)),
            PermissionDetail::Write(paths) => format!("编辑 {} 的内容", conjunction(paths)),
            PermissionDetail::ReadWrite(paths) => {
                format!("查看和编辑 {} 的内容", conjunction(paths))
            }
        })
        .collect();
    format!("允许 ChatGPT {}？", conjunction(&actions))
}

fn conjunction(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [left, right] => format!("{left}和{right}"),
        many => {
            let last = many.last().map(String::as_str).unwrap_or("");
            let head = many[..many.len() - 1].join("、");
            format!("{head}和{last}")
        }
    }
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(prompt: &ApprovalPrompt) -> Vec<&str> {
        prompt.options.iter().map(|option| option.id.as_str()).collect()
    }

    #[test]
    fn command_without_amendment_is_allow_once_or_deny() {
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/commandExecution/requestApproval",
            &json!({ "command": "npm test", "reason": "" }),
        ) else {
            panic!("expected a card");
        };
        assert_eq!(prompt.header, "终端");
        assert_eq!(prompt.question, "允许 ChatGPT 运行此命令？");
        assert_eq!(prompt.body, "npm test");
        assert_eq!(prompt.body_kind, "command");
        assert_eq!(ids(&prompt), ["accept", "decline"]);
        let accept = approval_result(&prompt.reply, "accept").unwrap();
        assert_eq!(accept, json!({ "decision": "accept" }));
        let deny = approval_result(&prompt.reply, "拒绝").unwrap();
        assert_eq!(deny, json!({ "decision": "decline" }));
    }

    #[test]
    fn command_reason_replaces_the_title_and_prefix_is_quoted() {
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/commandExecution/requestApproval",
            &json!({
                "command": "echo hi",
                "reason": "需要在仓库外写入",
                "proposedExecpolicyAmendment": ["npm", "run", "build"]
            }),
        ) else {
            panic!("expected a card");
        };
        assert_eq!(prompt.question, "需要在仓库外写入");
        assert_eq!(prompt.options[2].label, "允许类似命令");
        assert_eq!(
            prompt.options[2].tooltip,
            "允许在此对话中使用以 npm run build 开头的命令"
        );
        let decision = approval_result(&prompt.reply, "acceptWithExecpolicyAmendment").unwrap();
        assert_eq!(
            decision["decision"]["acceptWithExecpolicyAmendment"]["execpolicy_amendment"],
            json!(["npm", "run", "build"])
        );
    }

    #[test]
    fn newline_in_execpolicy_hides_similar_commands() {
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/commandExecution/requestApproval",
            &json!({
                "command": "echo hi",
                "proposedExecpolicyAmendment": ["npm\ntest"]
            }),
        ) else {
            panic!("expected a card");
        };
        assert_eq!(ids(&prompt), ["accept", "decline"]);
    }

    #[test]
    fn network_approval_uses_destination_and_allow_amendment() {
        let amendment = json!({ "action": "allow", "host": "example.com" });
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/commandExecution/requestApproval",
            &json!({
                "command": "curl https://example.com",
                "networkApprovalContext": { "protocol": "https", "host": "example.com" },
                "proposedNetworkPolicyAmendments": [{ "action": "deny" }, amendment]
            }),
        ) else {
            panic!("expected a card");
        };
        assert_eq!(prompt.header, "互联网访问");
        assert_eq!(prompt.question, "允许 ChatGPT 与 https://example.com 建立连接？");
        assert_eq!(prompt.subtitle, "example.com 不在当前网络允许列表中");
        assert_eq!(prompt.body, "");
        assert_eq!(
            ids(&prompt),
            ["applyNetworkPolicyAmendment", "accept", "decline", "acceptForSession"]
        );
        assert_eq!(prompt.options[0].label, "始终允许");
        assert_eq!(prompt.options[3].label, "允许此对话");
        let decision = approval_result(&prompt.reply, "applyNetworkPolicyAmendment").unwrap();
        assert_eq!(
            decision["decision"]["applyNetworkPolicyAmendment"]["network_policy_amendment"],
            amendment
        );
        let session = approval_result(&prompt.reply, "acceptForSession").unwrap();
        assert_eq!(session, json!({ "decision": "acceptForSession" }));
    }

    #[test]
    fn file_approval_lists_moves_and_accepts_for_the_session() {
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/fileChange/requestApproval",
            &json!({
                "grantRoot": "C:/repo",
                "changes": {
                    "src/a.ts": { "type": "update" },
                    "old.ts": { "type": "update", "move_path": "new.ts" }
                }
            }),
        ) else {
            panic!("expected a card");
        };
        assert_eq!(prompt.header, "编辑文件");
        assert_eq!(prompt.question, "是否允许 ChatGPT 编辑以下文件？");
        assert!(prompt.body.contains("src/a.ts"));
        assert!(prompt.body.contains("old.ts → new.ts"));
        assert_eq!(prompt.options[2].label, "允许所有修改");
        let decision = approval_result(&prompt.reply, "acceptForSession").unwrap();
        assert_eq!(decision, json!({ "decision": "acceptForSession" }));
    }

    #[test]
    fn file_approval_reads_changes_from_the_preceding_item() {
        let request = json!({
            "itemId": "exec-1",
            "reason": null,
            "grantRoot": null
        });
        let item = json!({
            "type": "fileChange",
            "id": "exec-1",
            "changes": [{
                "path": "approval-probe.txt",
                "kind": { "type": "add" },
                "diff": "hi\n"
            }]
        });
        let params = merge_file_changes(&request, Some(&item));
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/fileChange/requestApproval",
            &params,
        ) else {
            panic!("expected a card");
        };
        assert_eq!(prompt.body, "approval-probe.txt");
        assert_eq!(merge_file_changes(&request, None)["changes"], Value::Null);
    }

    #[test]
    fn empty_permissions_are_denied_without_a_card() {
        let result = approval_from_request(
            "item/permissions/requestApproval",
            &json!({ "permissions": {} }),
        );
        match result {
            ApprovalFromRequest::AutoDeny(value) => {
                assert_eq!(value, json!({ "permissions": {}, "scope": "turn" }));
            }
            ApprovalFromRequest::Prompt(_) => panic!("empty permissions should auto-deny"),
        }
    }

    #[test]
    fn permission_titles_follow_the_grouped_paths() {
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/permissions/requestApproval",
            &json!({
                "reason": "需要读取配置",
                "permissions": {
                    "network": { "enabled": true },
                    "fileSystem": {
                        "entries": [
                            { "access": "read", "path": { "type": "path", "path": "src/a.ts" } },
                            { "access": "write", "path": { "type": "path", "path": "src/a.ts" } },
                            { "access": "read", "path": { "type": "special", "value": { "kind": "tmpdir" } } }
                        ]
                    }
                }
            }),
        ) else {
            panic!("expected a card");
        };
        assert_eq!(prompt.header, "权限");
        assert_eq!(prompt.subtitle, "需要读取配置");
        assert_eq!(
            prompt.question,
            "允许 ChatGPT 连接到互联网、查看和编辑 src/a.ts 的内容和查看 :tmpdir 的内容？"
        );
        let once = approval_result(&prompt.reply, "accept").unwrap();
        assert_eq!(once["scope"], "turn");
        assert_eq!(once["strictAutoReview"], false);
        assert!(once["permissions"]["network"].is_object());
        let session = approval_result(&prompt.reply, "acceptForSession").unwrap();
        assert_eq!(session["scope"], "session");
        let deny = approval_result(&prompt.reply, "decline").unwrap();
        assert_eq!(deny, json!({ "permissions": {}, "scope": "turn" }));
    }

    #[test]
    fn network_only_permission_uses_the_internet_title() {
        let ApprovalFromRequest::Prompt(prompt) = approval_from_request(
            "item/permissions/requestApproval",
            &json!({ "permissions": { "network": { "enabled": true } } }),
        ) else {
            panic!("expected a card");
        };
        assert_eq!(prompt.header, "互联网访问");
        assert_eq!(prompt.question, "允许 ChatGPT 连接互联网？");
    }

    #[test]
    fn shell_token_quotes_spaces_and_leaves_the_unobserved_escaper() {
        assert_eq!(shell_token("npm"), "npm");
        assert_eq!(shell_token("my file"), "\"my file\"");
        assert_eq!(shell_token("say \"hi\""), "say \"hi\"");
    }
}
