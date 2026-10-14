//! 只读文本预览。HTML 另走内置浏览器，图片只返回 kind，不把字节当文本。

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use super::path::{file_name, preview_kind, resolve_preview_file};
use crate::models::strip_verbatim_prefix;

const MAX_PREVIEW_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PreviewDocument {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub text: String,
    pub truncated: bool,
}

pub fn read_preview_at(project_root: &Path, requested: &str) -> Result<PreviewDocument, String> {
    let full = resolve_preview_file(project_root, requested)?;
    let shown = strip_verbatim_prefix(&full.to_string_lossy());
    let name = file_name(&full);
    if preview_kind(&full) == "image" {
        return Ok(PreviewDocument {
            path: shown,
            name,
            kind: "image".into(),
            text: String::new(),
            truncated: false,
        });
    }
    let mut file = File::open(&full).map_err(|err| format!("无法读取文件: {err}"))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_PREVIEW_BYTES as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("无法读取文件: {err}"))?;
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_PREVIEW_BYTES);
    }
    if bytes.contains(&0) {
        return Ok(PreviewDocument {
            path: shown,
            name,
            kind: "binary".into(),
            text: String::new(),
            truncated: false,
        });
    }
    Ok(PreviewDocument {
        path: shown,
        name,
        kind: preview_kind(&full).into(),
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use super::super::image::read_image_at;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-preview-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_html_markdown_and_text_inside_the_project() {
        let root = scratch("kinds");
        fs::write(root.join("index.html"), "<p>preview-marker</p>").unwrap();
        fs::write(root.join("notes.md"), "# 笔记").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src").join("app.ts"), "export {}\n").unwrap();

        let html = read_preview_at(&root, "index.html").unwrap();
        assert_eq!(html.kind, "html");
        assert!(html.text.contains("preview-marker"));

        let markdown = read_preview_at(&root, "notes.md").unwrap();
        assert_eq!(markdown.kind, "markdown");
        assert!(markdown.text.contains("笔记"));

        let text = read_preview_at(&root, "src/app.ts").unwrap();
        assert_eq!(text.kind, "text");
        assert!(text.text.contains("export"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_files_outside_the_project_when_the_os_allows_it() {
        let root = scratch("outside");
        let outside = root.with_file_name(format!(
            "{}-out",
            root.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside-marker").unwrap();
        fs::write(root.join("ok.txt"), "yes").unwrap();
        fs::create_dir(root.join("subdir")).unwrap();

        let sibling = outside.join("secret.txt");
        let absolute = read_preview_at(&root, sibling.to_str().unwrap()).unwrap();
        assert!(
            absolute.text.contains("outside-marker"),
            "{}",
            absolute.text
        );
        let relative = format!(
            "../{}/secret.txt",
            outside.file_name().unwrap().to_string_lossy()
        );
        let escaped = read_preview_at(&root, &relative).unwrap();
        assert!(escaped.text.contains("outside-marker"), "{}", escaped.text);
        assert!(read_preview_at(&root, "ok.txt")
            .unwrap()
            .text
            .contains("yes"));
        let missing = read_preview_at(&root, "missing.txt").unwrap_err();
        assert!(missing.contains("找不到"), "{missing}");
        assert!(!missing.contains("只能预览"), "{missing}");
        let directory = read_preview_at(&root, "subdir").unwrap_err();
        assert!(directory.contains("不是文件"), "{directory}");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_symlink_that_points_outside_the_project() {
        let root = scratch("link");
        let outside = scratch("link-out");
        fs::write(outside.join("secret.txt"), "linked-marker").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("linked.txt")).unwrap();
        let doc = read_preview_at(&root, "linked.txt").unwrap();
        assert!(doc.text.contains("linked-marker"), "{}", doc.text);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn reads_a_png_as_image_bytes_and_not_as_text() {
        let root = scratch("image");
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
            0x02, 0xFE, 0xDC, 0xCC, 0x59, 0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
            0xAE, 0x42, 0x60, 0x82,
        ];
        fs::write(root.join("available-live.png"), png).unwrap();
        fs::write(
            root.join("mark.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n",
        )
        .unwrap();
        fs::write(root.join("notes.txt"), "not an image").unwrap();
        let listed = read_preview_at(&root, "available-live.png").unwrap();
        assert_eq!(listed.kind, "image");
        assert!(listed.text.is_empty());
        let image = read_image_at(&root, "available-live.png").unwrap();
        assert_eq!(image.mime, "image/png");
        assert_eq!(image.name, "available-live.png");
        assert!(!image.data_base64.is_empty());
        let svg = read_image_at(&root, "mark.svg").unwrap();
        assert_eq!(svg.mime, "image/svg+xml");
        let rejected = read_image_at(&root, "notes.txt").unwrap_err();
        assert!(
            rejected.contains("不能以图片预览") || rejected.contains("不一致"),
            "{rejected}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_the_operator_preview_directory_when_set() {
        let Ok(root) = std::env::var("AI_WORKBENCH_PREVIEW_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let html = read_preview_at(&root, "index.html").expect("index.html");
        assert_eq!(html.kind, "html");
        assert!(html.text.contains("preview-marker"), "{}", html.text);
        assert_eq!(read_preview_at(&root, "notes.md").unwrap().kind, "markdown");
        assert_eq!(read_preview_at(&root, "readme.txt").unwrap().kind, "text");
        match read_preview_at(&root, r"..\secret.txt") {
            Ok(_) => {}
            Err(err) => {
                assert!(!err.contains("只能预览"), "{err}");
                assert!(
                    err.contains("找不到") || err.contains("无法读取") || err.contains("不是文件"),
                    "{err}"
                );
            }
        }
    }
}
