//! 原生 imageGeneration 的结果与查看图片分开映射；实时和历史共用。

use serde_json::Value;

use super::history::ToolView;

pub(super) fn generation_view(item: &Value) -> ToolView {
    let status = item.get("status").and_then(Value::as_str).unwrap_or("");
    let failure = item.get("failure").filter(|value| !value.is_null());
    let failed = status == "failed" || failure.is_some();
    let image = if status == "completed" && !failed {
        nonempty(item, "savedPath").map(str::to_string).or_else(|| {
            nonempty(item, "result").map(|data| format!("data:image/png;base64,{data}"))
        })
    } else {
        None
    };
    let summary = if failed {
        "图片生成失败"
    } else if image.is_some() {
        "图片已生成"
    } else if status == "completed" {
        "未收到生成的图片"
    } else {
        "正在生成图片"
    };
    ToolView {
        // 适配器提供结果语义，界面不判断 Agent 名称或原生协议。
        name: "image_generation".into(),
        summary: summary.into(),
        detail: failure
            .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))
            .unwrap_or_default(),
        images: image.into_iter().collect(),
        ..ToolView::default()
    }
}

fn nonempty<'a>(item: &'a Value, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::history::{bodies_from_turns, tool_event, tool_view};
    use aiwb_core::models::SessionEventBody;
    use serde_json::json;

    #[test]
    fn generated_image_uses_native_saved_path_in_live_and_history() {
        // 字段来自真实 CLI thread/read 的 imageGeneration 条目。
        let item = json!({
            "type": "imageGeneration", "id": "generated", "status": "completed",
            "savedPath": "C:\\images\\generated.png", "result": "unused-base64",
            "revisedPrompt": "a bowl", "transparentBackground": false, "failure": null
        });
        let live = tool_event(tool_view(&item).unwrap(), Some("generated".into()));
        let history = bodies_from_turns(&[json!({ "items": [item] })]);
        for body in [&live, &history[0]] {
            assert!(matches!(body, SessionEventBody::ToolCall { name, images, .. }
                if name == "image_generation" && images == &["C:\\images\\generated.png"]));
        }
    }

    #[test]
    fn generated_image_without_path_keeps_the_entire_base64_payload() {
        let data = "YWJj".repeat(10_000);
        let item = json!({ "type": "imageGeneration", "status": "completed", "savedPath": "", "result": data });
        let event = tool_event(tool_view(&item).unwrap(), None);
        assert!(matches!(event, SessionEventBody::ToolCall { images, .. }
            if images == [format!("data:image/png;base64,{data}")]));
    }

    #[test]
    fn pending_failed_and_empty_results_do_not_claim_an_image() {
        for item in [
            json!({ "status": "inProgress", "result": "partial" }),
            json!({ "status": "failed", "failure": "generation failed", "savedPath": "partial.png" }),
            json!({ "status": "completed", "result": "" }),
        ] {
            assert!(generation_view(&item).images.is_empty());
        }
        assert_eq!(generation_view(&json!({ "status": "failed", "failure": "generation failed" })).detail, "generation failed");
    }
}
