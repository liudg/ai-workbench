//! 用户回合。图片和页面批注在这里折成各适配器都能发送的输入，不识别某一种 CLI。

use aiwb_core::models::PageAnnotation;

/// 用户要发出的一轮。图片是本机路径或 `data:` / `https:` 地址。
#[derive(Debug, Clone)]
pub struct UserTurn {
    pub text: String,
    pub images: Vec<String>,
    pub client_id: String,
    /// 页面批注。默认折进正文和图片附件。
    pub annotations: Vec<PageAnnotation>,
}

/// `deliver` 的结果。排队时调用方不要再写用户气泡。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnDelivery {
    Started,
    Queued,
}

/// 把页面批注折进即将发给任何 Agent 的正文，并把截图路径并进图片列表。
pub fn fold_page_annotations(
    text: &str,
    images: &mut Vec<String>,
    notes: &[PageAnnotation],
) -> String {
    if notes.is_empty() {
        return text.to_string();
    }
    let mut blocks = Vec::with_capacity(notes.len());
    for (index, note) in notes.iter().enumerate() {
        let mut lines = vec![format!("页面批注 {}", index + 1)];
        let comment = note.comment.trim();
        if !comment.is_empty() {
            lines.push(format!("评论：{comment}"));
        }
        let url = note.url.trim();
        if !url.is_empty() {
            lines.push(format!("页面：{url}"));
        }
        let selector = note.selector.trim();
        if !selector.is_empty() {
            lines.push(format!("选择器：{selector}"));
        }
        let element = note.text.trim();
        if !element.is_empty() {
            lines.push(format!("元素文本：{}", clamp_chars(element, 500)));
        }
        lines.push(format!(
            "区域：{},{} {}×{}",
            note.x, note.y, note.width, note.height
        ));
        if let Some(path) = note
            .screenshot
            .as_ref()
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
        {
            lines.push("附图为该区域的截图。".into());
            if !images.iter().any(|item| item == path) {
                images.push(path.to_string());
            }
        }
        blocks.push(lines.join("\n"));
    }
    let extra = blocks.join("\n\n");
    if text.trim().is_empty() {
        extra
    } else {
        format!("{text}\n\n{extra}")
    }
}

pub(crate) fn fold_images_into_text(text: &str, images: &[String]) -> String {
    if images.is_empty() {
        return text.to_string();
    }
    let names = images
        .iter()
        .map(|path| {
            std::path::Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path.as_str())
        })
        .collect::<Vec<_>>()
        .join("、");
    let line = format!("附件：{names}");
    if text.trim().is_empty() {
        line
    } else {
        format!("{text}\n\n{line}")
    }
}

fn clamp_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}
