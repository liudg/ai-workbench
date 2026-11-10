//! 取消请求的上下文补回，以及原生历史回放时隐藏宿主添加的部分。
use serde_json::{json, Value};

const OPEN: &str = "The previous request was interrupted. The following is context from that request, including prior user instructions and observed results. Continue from the existing work; do not repeat completed actions. The latest user instruction appears after this context and takes precedence where it changes the earlier request.\n<interrupted_request_context>";
const CLOSE: &str = "</interrupted_request_context>\nLatest user instruction:";

pub(super) fn prepend(context: Vec<Value>, current: &mut Vec<Value>) {
    if context.is_empty() {
        return;
    }
    let mut blocks = vec![json!({"type":"text", "text":OPEN})];
    blocks.extend(context);
    blocks.push(json!({"type":"text", "text":CLOSE}));
    blocks.append(current);
    *current = blocks;
}

pub(super) fn user_text(text: &str) -> &str {
    if text.starts_with(OPEN) {
        if let Some((_, user)) = text.rsplit_once(CLOSE) {
            return user.strip_prefix('\n').unwrap_or(user);
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_hides_nested_cancellation_context_and_preserves_normal_text() {
        let text = |s| json!({"type":"text", "text":s});
        let mut second = vec![text("second")];
        prepend(
            vec![
                text("first"),
                json!({"type":"image", "data":"aGk=", "mimeType":"image/png"}),
            ],
            &mut second,
        );
        let mut third = vec![text("  third\nwith indentation")];
        prepend(second, &mut third);
        let wire_text = third
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(user_text(&wire_text), "  third\nwith indentation");
        assert!(third.iter().any(|block| block["type"] == "image"));
        assert_eq!(user_text("normal text"), "normal text");
        assert_eq!(user_text(CLOSE), CLOSE);
    }
}
