//! 项目内文件预览。只读文本，路径必须落在该项目目录里。
//! HTML 另走内置浏览器（`browser`），不经过某个 Agent。

pub(crate) mod browser;

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::State;

use crate::features::projects::ProjectStore;
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

#[tauri::command]
pub fn read_preview_file(
    store: State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<PreviewDocument, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    read_preview_at(Path::new(&project.path), &path)
}

/// 工作树差异。范围只含未提交、未暂存、已暂存；已提交和分支的子菜单没有观察到。
#[tauri::command]
pub fn project_git_diff(
    store: State<'_, ProjectStore>,
    project_id: String,
    scope: String,
    ignore_whitespace: bool,
) -> Result<String, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    git_diff_text(Path::new(&project.path), &scope, ignore_whitespace)
}

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

pub fn git_diff_text(root: &Path, scope: &str, ignore_whitespace: bool) -> Result<String, String> {
    if !root.is_dir() {
        return Err("项目不存在".into());
    }
    let mut args = vec![
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-color",
    ];
    if ignore_whitespace {
        args.push("-w");
    }
    match scope {
        "uncommitted" => args.push("HEAD"),
        "unstaged" => {}
        "staged" => args.push("--cached"),
        "committed" | "branch" => return Err("这个范围没有可用的差异".into()),
        _ => return Err("不支持的差异范围".into()),
    }
    args.push("--");

    let mut command = Command::new("git");
    command
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    crate::encoding::apply_utf8_env_std(&mut command);
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法运行 git: {err}"))?;
    if !output.status.success() {
        let stderr = crate::encoding::decode_child_bytes(&output.stderr);
        let stderr = stderr.trim();
        if stderr.contains("not a git repository") {
            return Err("当前目录不是 git 仓库".into());
        }
        if stderr.is_empty() {
            return Err("git diff 失败".into());
        }
        return Err(stderr.to_string());
    }
    if output.stdout.len() > MAX_DIFF_BYTES {
        return Err("差异太大，无法完整显示".into());
    }
    Ok(crate::encoding::decode_child_bytes(&output.stdout).into_owned())
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

pub fn resolve_preview_file(project_root: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = candidate_path(project_root, requested)?;
    if !is_inside(project_root, &candidate) {
        return Err("只能预览当前项目里的文件".into());
    }
    let full = match candidate.canonicalize() {
        Ok(real) => {
            let root_real = project_root
                .canonicalize()
                .unwrap_or_else(|_| project_root.to_path_buf());
            if !is_inside(&root_real, &real) {
                return Err("只能预览当前项目里的文件".into());
            }
            real
        }
        Err(_) if candidate.is_file() => candidate,
        Err(_) => return Err("找不到文件".into()),
    };
    if !full.is_file() {
        return Err("不是文件".into());
    }
    Ok(full)
}

pub fn read_preview_at(project_root: &Path, requested: &str) -> Result<PreviewDocument, String> {
    let full = resolve_preview_file(project_root, requested)?;
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
    let shown = strip_verbatim_prefix(&full.to_string_lossy());
    let name = full
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("文件")
        .to_string();
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

fn candidate_path(project_root: &Path, requested: &str) -> Result<PathBuf, String> {
    let trimmed = requested.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("没有文件路径".into());
    }
    let decoded = file_url_path(trimmed).unwrap_or_else(|| trimmed.to_string());
    let without_query = decoded.split(['?', '#']).next().unwrap_or(decoded.as_str());
    let path = Path::new(without_query);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    };
    Ok(lexical_normalize(&joined))
}

fn file_url_path(value: &str) -> Option<String> {
    let rest = value.strip_prefix("file:")?;
    let rest = rest.trim_start_matches('/');
    if rest.len() >= 2 && rest.as_bytes()[1] == b':' {
        return Some(rest.replace('/', "\\"));
    }
    if value.starts_with("file:///") {
        let path = value.trim_start_matches("file:///").replace('/', "\\");
        if path.len() >= 2 && path.as_bytes()[1] == b':' {
            return Some(path);
        }
    }
    None
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn is_inside(root: &Path, candidate: &Path) -> bool {
    let root = lexical_normalize(root);
    let candidate = lexical_normalize(candidate);
    let root_key = path_key(&root);
    let candidate_key = path_key(&candidate);
    candidate_key == root_key || candidate_key.starts_with(&format!("{root_key}\\"))
}

fn path_key(path: &Path) -> String {
    let mut text = strip_verbatim_prefix(&path.to_string_lossy()).replace('/', "\\");
    if text.ends_with('\\') && text.len() > 3 {
        text.pop();
    }
    text.to_lowercase()
}

fn preview_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "html",
        "md" | "markdown" | "mdx" => "markdown",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
    fn rejects_paths_that_leave_the_project() {
        let root = scratch("jail");
        let outside = root.with_file_name(format!(
            "{}-evil",
            root.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "nope").unwrap();
        fs::write(root.join("ok.txt"), "yes").unwrap();

        let escaped = read_preview_at(&root, r"..\secret.txt").unwrap_err();
        assert!(escaped.contains("只能预览"), "{escaped}");
        let sibling = outside.join("secret.txt");
        let absolute = read_preview_at(&root, sibling.to_str().unwrap()).unwrap_err();
        assert!(absolute.contains("只能预览"), "{absolute}");
        assert!(read_preview_at(&root, "ok.txt").is_ok());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
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
        let escaped = read_preview_at(&root, r"..\secret.txt").unwrap_err();
        assert!(escaped.contains("只能预览"), "{escaped}");
    }

    fn run_git(cwd: &Path, args: &[&str]) -> bool {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut command);
        command.status().map(|status| status.success()).unwrap_or(false)
    }

    #[test]
    fn git_diff_follows_uncommitted_unstaged_and_staged() {
        let mut probe = Command::new("git");
        probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
        hide_console(&mut probe);
        if !probe.status().map(|status| status.success()).unwrap_or(false) {
            return;
        }
        let root = scratch("git-scope");
        assert!(run_git(&root, &["init"]));
        assert!(run_git(&root, &["config", "user.email", "diff@example.com"]));
        assert!(run_git(&root, &["config", "user.name", "diff"]));
        assert!(run_git(&root, &["config", "core.autocrlf", "false"]));
        fs::write(root.join("note.txt"), "one\n").unwrap();
        assert!(run_git(&root, &["add", "note.txt"]));
        assert!(run_git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-m", "base"]
        ));

        fs::write(root.join("note.txt"), "two\n").unwrap();
        let unstaged = git_diff_text(&root, "unstaged", false).unwrap();
        assert!(unstaged.contains("+two"), "{unstaged}");
        assert!(git_diff_text(&root, "staged", false).unwrap().is_empty());
        assert!(git_diff_text(&root, "uncommitted", false).unwrap().contains("+two"));

        assert!(run_git(&root, &["add", "note.txt"]));
        assert!(git_diff_text(&root, "unstaged", false).unwrap().is_empty());
        let staged = git_diff_text(&root, "staged", false).unwrap();
        assert!(staged.contains("+two"), "{staged}");
        assert!(git_diff_text(&root, "committed", false).unwrap_err().contains("没有可用"));
        assert!(git_diff_text(&root, "branch", false).unwrap_err().contains("没有可用"));

        fs::write(root.join("note.txt"), "two \n").unwrap();
        assert!(run_git(&root, &["add", "note.txt"]));
        fs::write(root.join("note.txt"), "two\n").unwrap();
        let spaced = git_diff_text(&root, "unstaged", false).unwrap();
        assert!(spaced.contains('-') || spaced.contains('+'), "{spaced}");
        assert!(git_diff_text(&root, "unstaged", true).unwrap().trim().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
