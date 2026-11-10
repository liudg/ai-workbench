//! 计划模式回合结束后那张「实施此计划？」卡片。选项 id、发给模型的实施句、
//! 清空上下文前缀来自 Codex TUI `chatwidget/plan_implementation.rs`。

use aiwb_core::models::PromptOption;

pub const PLAN_IMPLEMENTATION_TITLE: &str = "实施此计划？";
const PLAN_IMPLEMENTATION_YES: &str = "是，实施此计划";
const PLAN_IMPLEMENTATION_CLEAR_CONTEXT: &str = "是，清空上下文并实施";
const PLAN_IMPLEMENTATION_NO: &str = "否，留在计划模式";
pub const PLAN_IMPLEMENTATION_CODING_MESSAGE: &str = "Implement the plan.";
pub const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX: &str = concat!(
    "Implement the plan in a fresh context. Treat the plan as the source of ",
    "user intent, re-read files as needed, and carry the work through ",
    "implementation and verification."
);
const PLAN_IMPLEMENTATION_NO_APPROVED_PLAN: &str = "没有可实施的计划";
pub const IMPLEMENT_ID: &str = "implement";
pub const CLEAR_CONTEXT_ID: &str = "clear-context";
const STAY_ID: &str = "stay";

/// 用户对实施确认的回答。
#[derive(Debug)]
pub enum PlanChoice {
    Selected(PromptOption),
    /// 不是选项 id 的正文：留在计划模式，当作下一轮计划反馈发出。
    Feedback(String),
}

/// 空答案仍要求选一项。其它非选项正文是计划反馈，不报「请选择一个选项」。
pub fn classify_plan_answer(value: &str, plan_markdown: Option<&str>) -> Result<PlanChoice, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("请选择一个选项".into());
    }
    let options = plan_implementation_options(plan_markdown, None);
    if let Some(choice) = options.into_iter().find(|option| option.id == trimmed) {
        if let Some(reason) = choice.disabled_reason.clone() {
            return Err(reason);
        }
        return Ok(PlanChoice::Selected(choice));
    }
    Ok(PlanChoice::Feedback(trimmed.to_string()))
}

/// 三个选项。slot 让界面把这张卡放在输入框上方。清空上下文那项在没有计划正文时不可选。
pub fn plan_implementation_options(
    plan_markdown: Option<&str>,
    usage_label: Option<&str>,
) -> Vec<PromptOption> {
    let has_plan = plan_markdown.is_some_and(|plan| !plan.trim().is_empty());
    vec![
        PromptOption {
            id: IMPLEMENT_ID.into(),
            label: PLAN_IMPLEMENTATION_YES.into(),
            description: "切换到默认模式并开始编码".into(),
            slot: "primary".into(),
            ..Default::default()
        },
        PromptOption {
            id: CLEAR_CONTEXT_ID.into(),
            label: PLAN_IMPLEMENTATION_CLEAR_CONTEXT.into(),
            description: usage_label.map_or_else(
                || "用这份计划开一个新线程".to_string(),
                |label| format!("用这份计划开一个新线程（当前上下文：{label}）"),
            ),
            disabled_reason: (!has_plan).then(|| PLAN_IMPLEMENTATION_NO_APPROVED_PLAN.into()),
            slot: "leading".into(),
            ..Default::default()
        },
        PromptOption {
            id: STAY_ID.into(),
            label: PLAN_IMPLEMENTATION_NO.into(),
            description: "继续和模型完善计划".into(),
            slot: "deny".into(),
            ..Default::default()
        },
    ]
}
