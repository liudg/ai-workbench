//! `/status`：移植 openai/codex rust-v0.162.1 `tui/src/status/card.rs`、`format.rs`、
//! `helpers.rs`、`rate_limits.rs` 的文字部分（时间线按纯文本显示，没有颜色）。
//!
//! 数据来源：模型、线程、权限来自本会话；账户来自 `account/read`；
//! 额度来自 `account/rateLimits/read`；用量来自 `thread/tokenUsage/updated`。
//! TUI 卡片里的 Server / Model provider / Forked from / 线程用量估算 / Credits 行没有移植。

use chrono::{DateTime, Local, Utc};
use serde_json::Value;

use super::tokens::{format_tokens_compact, TokenUsage, TokenUsageInfo};

const CHATGPT_USAGE_URL: &str = "https://chatgpt.com/settings/usage";
const STATUS_LIMIT_BAR_SEGMENTS: usize = 20;
const INDENT: &str = "  ";

pub(super) struct StatusInput {
    pub version: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub directory: String,
    pub permissions: String,
    pub agents_summary: String,
    pub account: Option<Value>,
    pub thread_name: Option<String>,
    pub collaboration_mode: Option<&'static str>,
    pub session_id: Option<String>,
    pub token_info: Option<TokenUsageInfo>,
    /// `account/rateLimits/read` 的结果；请求失败为 None。
    pub rate_limits: Option<Value>,
    pub now: DateTime<Local>,
}

/// `/status` 每次都现读 `account/rateLimits/read`，所以没有 TUI 缓存快照的「可能过期」分支。
enum LimitRows {
    Available(Vec<(String, String)>),
    Unavailable,
    Missing,
}

pub(super) fn render(input: &StatusInput) -> String {
    let account = account_value(input.account.as_ref());
    let is_chatgpt = input
        .account
        .as_ref()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        == Some("chatgpt");
    let total = input.token_info.map(|info| info.total).unwrap_or_default();
    let (context_usage, window) = match input.token_info {
        Some(info) => (info.last, info.model_context_window),
        None => (TokenUsage::default(), None),
    };
    let limits = limit_rows(input.rate_limits.as_ref(), input.now);

    let mut labels: Vec<String> = ["Model", "Directory", "Permissions", "Agents.md"]
        .iter()
        .map(|label| label.to_string())
        .collect();
    let mut push = |label: &str| {
        if !labels.iter().any(|item| item == label) {
            labels.push(label.to_string());
        }
    };
    if account.is_some() {
        push("Account");
    }
    if input.thread_name.as_deref().is_some_and(|name| !name.is_empty()) {
        push("Thread name");
    }
    if input.session_id.is_some() {
        push("Session");
    }
    if input.collaboration_mode.is_some() {
        push("Collaboration mode");
    }
    push("Token usage");
    if window.is_some() {
        push("Context window");
    }
    match &limits {
        LimitRows::Available(rows) if !rows.is_empty() => {
            for (label, _) in rows {
                push(label);
            }
        }
        _ => push("Limits"),
    }
    let width = labels.iter().map(|label| label.chars().count()).max().unwrap_or(0);
    let line = |label: &str, value: &str| {
        let padding = 2 + width.saturating_sub(label.chars().count());
        format!("{INDENT}{label}:{}{value}", " ".repeat(padding))
    };

    let mut out = vec![format!("{INDENT}>_ OpenAI Codex (v{})", input.version), String::new()];
    if is_chatgpt {
        out.push(format!("{INDENT}Visit {CHATGPT_USAGE_URL} for up-to-date"));
        out.push(format!("{INDENT}information on rate limits and credits"));
        out.push(String::new());
    }
    let model = match input.reasoning_effort.as_deref().filter(|e| !e.is_empty()) {
        Some(effort) => format!("{} (reasoning {})", input.model, effort.to_ascii_lowercase()),
        None => input.model.clone(),
    };
    out.push(line("Model", &model));
    out.push(line("Directory", &input.directory));
    out.push(line("Permissions", &input.permissions));
    out.push(line("Agents.md", &input.agents_summary));
    if let Some(account) = &account {
        out.push(line("Account", account));
    }
    if let Some(name) = input.thread_name.as_deref().filter(|name| !name.is_empty()) {
        out.push(line("Thread name", name));
    }
    if let Some(mode) = input.collaboration_mode {
        out.push(line("Collaboration mode", mode));
    }
    if let Some(session) = &input.session_id {
        out.push(line("Session", session));
    }
    out.push(String::new());
    // TUI 对 ChatGPT 订阅账户隐藏 Token usage。
    if !is_chatgpt {
        out.push(line(
            "Token usage",
            &format!(
                "{} total  ({} input + {} output)",
                format_tokens_compact(total.blended_total()),
                format_tokens_compact(total.non_cached_input()),
                format_tokens_compact(total.output_tokens)
            ),
        ));
    }
    if let Some(window) = window {
        out.push(line(
            "Context window",
            &format!(
                "{}% left ({} used / {})",
                context_usage.percent_of_context_window_remaining(window),
                format_tokens_compact(context_usage.tokens_in_context_window()),
                format_tokens_compact(window)
            ),
        ));
    }
    match limits {
        LimitRows::Available(rows) if rows.is_empty() => {
            out.push(line("Limits", "not available for this account"))
        }
        LimitRows::Available(rows) => out.extend(rows.iter().map(|(l, v)| line(l, v))),
        LimitRows::Unavailable => out.push(line("Limits", "not available for this account")),
        LimitRows::Missing => out.push(line("Limits", "data not available yet")),
    }
    out.join("\n")
}

fn account_value(account: Option<&Value>) -> Option<String> {
    let account = account?;
    match account.get("type").and_then(Value::as_str)? {
        "chatgpt" => {
            let email = account.get("email").and_then(Value::as_str);
            let plan = account
                .get("planType")
                .and_then(Value::as_str)
                .map(plan_label);
            Some(match (email, plan) {
                (Some(email), Some(plan)) => format!("{email} ({plan})"),
                (Some(email), None) => email.to_string(),
                (None, Some(plan)) => plan.to_string(),
                (None, None) => "ChatGPT".to_string(),
            })
        }
        "apiKey" => Some("API key configured (run codex login to use ChatGPT)".to_string()),
        _ => None,
    }
}

/// `subscription.rs::SubscriptionDisplay::Status`。
fn plan_label(plan: &str) -> &'static str {
    match plan {
        "free" => "Free",
        "go" => "Go",
        "plus" => "Plus",
        "pro" => "Pro 200",
        "prolite" => "Pro 100",
        "promax" => "Pro 500",
        "team" | "self_serve_business_usage_based" => "Business",
        "business" => "Enterprise",
        "self_serve_business_prolite" => "Business Premium",
        "enterprise_cbp_automation" => "Enterprise (Automation)",
        "enterprise" | "ent26" | "enterprise_cbp_usage_based" => "Enterprise",
        "edu" => "Edu",
        "edu_plus" => "Edu Plus",
        "edu_pro" => "Edu Pro",
        _ => "Unknown",
    }
}

fn limit_rows(response: Option<&Value>, now: DateTime<Local>) -> LimitRows {
    let Some(response) = response else {
        return LimitRows::Missing;
    };
    let mut snapshots: Vec<&Value> = response
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .map(|map| map.values().collect())
        .unwrap_or_default();
    if snapshots.is_empty() {
        if let Some(single) = response.get("rateLimits") {
            snapshots.push(single);
        }
    }
    if snapshots.is_empty() {
        return LimitRows::Missing;
    }
    let name = |snapshot: &Value| {
        snapshot
            .get("limitName")
            .and_then(Value::as_str)
            .or_else(|| snapshot.get("limitId").and_then(Value::as_str))
            .unwrap_or("codex")
            .to_string()
    };
    snapshots.sort_by_key(|snapshot| !name(snapshot).eq_ignore_ascii_case("codex"));
    let mut rows = Vec::new();
    for snapshot in snapshots {
        let primary = snapshot.get("primary").filter(|value| !value.is_null());
        let secondary = snapshot.get("secondary").filter(|value| !value.is_null());
        if primary.is_none() && secondary.is_none() {
            continue;
        }
        let bucket = name(snapshot);
        let prefixed = !bucket.eq_ignore_ascii_case("codex");
        let windows = usize::from(primary.is_some()) + usize::from(secondary.is_some());
        let combine = prefixed && windows == 1;
        if prefixed && !combine {
            rows.push((format!("{bucket} limit"), String::new()));
        }
        for (window, secondary_slot) in [(primary, false), (secondary, true)] {
            let Some(window) = window else { continue };
            let minutes = window.get("windowDurationMins").and_then(Value::as_i64);
            let label = capitalize_first(&limit_label_for_window(minutes, secondary_slot));
            let label = if combine {
                format!("{bucket} {label} limit")
            } else {
                format!("{label} limit")
            };
            let used = window.get("usedPercent").and_then(Value::as_f64).unwrap_or(0.0);
            let remaining = (100.0 - used).clamp(0.0, 100.0);
            let mut value = format!("{} {remaining:.0}% left", progress_bar(remaining));
            if let Some(reset) = window
                .get("resetsAt")
                .and_then(Value::as_i64)
                .and_then(|secs| DateTime::<Utc>::from_timestamp(secs, 0))
            {
                value.push_str(&format!(
                    " (resets {})",
                    format_reset(reset.with_timezone(&Local), now)
                ));
            }
            rows.push((label, value));
        }
    }
    if rows.is_empty() {
        LimitRows::Unavailable
    } else {
        LimitRows::Available(rows)
    }
}

fn progress_bar(percent_remaining: f64) -> String {
    let ratio = (percent_remaining / 100.0).clamp(0.0, 1.0);
    let filled = ((ratio * STATUS_LIMIT_BAR_SEGMENTS as f64).round() as usize)
        .min(STATUS_LIMIT_BAR_SEGMENTS);
    format!(
        "[{}{}]",
        "█".repeat(filled),
        "░".repeat(STATUS_LIMIT_BAR_SEGMENTS - filled)
    )
}

/// `helpers.rs::format_reset_timestamp`，24 小时制。
fn format_reset(dt: DateTime<Local>, now: DateTime<Local>) -> String {
    let time = dt.format("%H:%M").to_string();
    if dt.date_naive() == now.date_naive() {
        time
    } else {
        format!("{time} on {}", dt.format("%-d %b"))
    }
}

/// `chatwidget/rate_limits.rs::limit_label_for_window`。
fn limit_label_for_window(minutes: Option<i64>, secondary: bool) -> String {
    const HOUR: i64 = 60;
    const DAY: i64 = 24 * HOUR;
    let approx = |minutes: i64, expected: i64| {
        let (m, e) = (minutes as f64, expected as f64);
        m >= e * 0.95 && m <= e * 1.05
    };
    let duration = minutes.map(|m| m.max(0)).and_then(|m| {
        if approx(m, 5 * HOUR) {
            Some("5h")
        } else if approx(m, DAY) {
            Some("daily")
        } else if approx(m, 7 * DAY) {
            Some("weekly")
        } else if approx(m, 30 * DAY) {
            Some("monthly")
        } else if approx(m, 365 * DAY) {
            Some("annual")
        } else {
            None
        }
    });
    duration
        .unwrap_or(if secondary { "secondary usage" } else { "usage" })
        .to_string()
}

fn capitalize_first(input: &str) -> String {
    let mut chars = input.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `helpers.rs::format_directory_display`：家目录下显示成 `~`。
pub(super) fn directory_display(cwd: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if !home.is_empty() {
        let home = home.trim_end_matches(['/', '\\']);
        if cwd == home {
            return "~".into();
        }
        for sep in ['/', '\\'] {
            if let Some(rest) = cwd.strip_prefix(&format!("{home}{sep}")) {
                return format!("~{sep}{rest}");
            }
        }
    }
    cwd.to_string()
}

/// `helpers.rs::compose_agents_summary`（只处理本机路径）。
pub(super) fn agents_summary(cwd: &str, sources: &[String]) -> String {
    let cwd_path = std::path::Path::new(cwd);
    let rels: Vec<String> = sources
        .iter()
        .map(|source| {
            let path = std::path::Path::new(source);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "<unknown>".into());
            match path.parent() {
                Some(parent) if parent == cwd_path => name,
                Some(parent) => {
                    let mut ups = 0usize;
                    let mut cur = cwd_path;
                    let mut reached = false;
                    loop {
                        if cur == parent {
                            reached = true;
                            break;
                        }
                        match cur.parent() {
                            Some(next) => {
                                cur = next;
                                ups += 1;
                            }
                            None => break,
                        }
                    }
                    if reached {
                        format!("{}{name}", format!("..{}", std::path::MAIN_SEPARATOR).repeat(ups))
                    } else if let Ok(stripped) = path.strip_prefix(cwd_path) {
                        stripped.to_string_lossy().to_string()
                    } else {
                        source.clone()
                    }
                }
                None => source.clone(),
            }
        })
        .collect();
    if rels.is_empty() {
        "<none>".into()
    } else {
        rels.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input() -> StatusInput {
        StatusInput {
            version: "0.162.1".into(),
            model: "gpt-5.5".into(),
            reasoning_effort: Some("Medium".into()),
            directory: "~/repo".into(),
            permissions: "Workspace (Ask for approval)".into(),
            agents_summary: "<none>".into(),
            account: None,
            thread_name: Some("Fix tests".into()),
            collaboration_mode: Some("Default"),
            session_id: Some("thr_1".into()),
            token_info: None,
            rate_limits: None,
            now: Local::now(),
        }
    }

    #[test]
    fn card_rows_follow_the_tui_order_and_alignment() {
        let text = render(&input());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "  >_ OpenAI Codex (v0.162.1)");
        assert_eq!(lines[2], "  Model:               gpt-5.5 (reasoning medium)");
        assert_eq!(lines[3], "  Directory:           ~/repo");
        assert_eq!(lines[4], "  Permissions:         Workspace (Ask for approval)");
        assert_eq!(lines[5], "  Agents.md:           <none>");
        assert_eq!(lines[6], "  Thread name:         Fix tests");
        assert_eq!(lines[7], "  Collaboration mode:  Default");
        assert_eq!(lines[8], "  Session:             thr_1");
        assert_eq!(lines[10], "  Token usage:         0 total  (0 input + 0 output)");
        assert_eq!(lines[11], "  Limits:              data not available yet");
    }

    #[test]
    fn chatgpt_accounts_hide_tokens_and_show_limits() {
        let mut status = input();
        status.account = Some(json!({ "type": "chatgpt", "email": "a@b.c", "planType": "plus" }));
        status.rate_limits = Some(json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 25, "windowDurationMins": 300, "resetsAt": null },
                "secondary": { "usedPercent": 60, "windowDurationMins": 10080, "resetsAt": null }
            }
        }));
        let text = render(&status);
        assert!(text.contains("Visit https://chatgpt.com/settings/usage for up-to-date"));
        assert!(text.contains("Account:             a@b.c (Plus)"));
        assert!(!text.contains("Token usage"));
        assert!(text.contains("5h limit:            [███████████████░░░░░] 75% left"));
        assert!(text.contains("Weekly limit:        [████████░░░░░░░░░░░░] 40% left"));
    }

    #[test]
    fn helpers_match_the_tui() {
        assert_eq!(limit_label_for_window(Some(1440), false), "daily");
        assert_eq!(limit_label_for_window(None, true), "secondary usage");
        assert_eq!(agents_summary("/r", &[]), "<none>");
        assert_eq!(agents_summary("/r/a", &["/r/a/AGENTS.md".into(), "/r/AGENTS.md".into()]), "AGENTS.md, ../AGENTS.md");
        let api = account_value(Some(&json!({ "type": "apiKey" })));
        assert_eq!(api.as_deref(), Some("API key configured (run codex login to use ChatGPT)"));
    }
}
