//! 无项目任务文件夹：独立聊天在这里按 `YYYY-MM-DD/<slug>` 建工作目录。
//! 照 v1 `src-tauri/src/features/chats/folder.rs`。

use std::fs;
use std::path::{Path, PathBuf};

use aiwb_core::chat_slug::{candidate_name, chat_slug};
use serde::{Deserialize, Serialize};

use super::projects::{normalize_dir, strip_verbatim};
use super::{ServiceResult, Services};

const FOLDER_NAME: &str = "AI Workbench";
const META_KEY: &str = "task_folder";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TaskFolder {
    path: String,
    /// 在文档目录下时写成「文档/…」。
    label: String,
}

#[derive(Deserialize)]
pub(crate) struct SetTaskFolder {
    path: String,
}

impl Services {
    fn task_folder_path(&self) -> ServiceResult<PathBuf> {
        let custom = self.store.meta(META_KEY).map_err(|e| e.to_string())?;
        Ok(match custom.filter(|path| !path.trim().is_empty()) {
            Some(path) => PathBuf::from(path),
            None => documents_dir().join(FOLDER_NAME),
        })
    }

    pub(crate) fn task_folder(&self) -> ServiceResult<TaskFolder> {
        Ok(folder_view(&self.task_folder_path()?, &documents_dir()))
    }

    pub(crate) fn set_task_folder(&self, params: SetTaskFolder) -> ServiceResult<TaskFolder> {
        let dir = normalize_dir(&params.path)?;
        self.store
            .set_meta(META_KEY, &dir.to_string_lossy())
            .map_err(|e| e.to_string())?;
        self.task_folder()
    }

    /// 给一条独立聊天建工作目录。
    pub(crate) fn allocate_chat_dir(&self, prompt: &str) -> ServiceResult<PathBuf> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        allocate_chat_dir(&self.task_folder_path()?, prompt, &today)
    }
}

/// 旧版把自定义的任务文件夹记在 `task-folder.json`，第一次启动时搬进数据库。
pub(crate) fn import_legacy_task_folder(store: &aiwb_store::Store, data_dir: &Path) -> ServiceResult<()> {
    #[derive(Deserialize)]
    struct Legacy {
        path: Option<String>,
    }
    if store.meta(META_KEY).map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let Ok(raw) = fs::read_to_string(data_dir.join("task-folder.json")) else {
        return Ok(());
    };
    let Ok(Legacy { path: Some(path) }) = serde_json::from_str::<Legacy>(&raw) else {
        return Ok(());
    };
    if path.trim().is_empty() {
        return Ok(());
    }
    store.set_meta(META_KEY, path.trim()).map_err(|e| e.to_string())
}

fn documents_dir() -> PathBuf {
    dirs::document_dir()
        .filter(|path| path.is_dir())
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .unwrap_or_else(|| std::env::temp_dir().join("Documents"))
}

fn allocate_chat_dir(root: &Path, prompt: &str, today: &str) -> ServiceResult<PathBuf> {
    let day = root.join(today);
    fs::create_dir_all(&day).map_err(|err| format!("创建任务目录失败 {}: {err}", day.display()))?;
    let slug = chat_slug(prompt);
    for index in 0..1000 {
        let dir = day.join(candidate_name(&slug, index));
        match fs::create_dir(&dir) {
            Ok(()) => {
                let canonical = dir
                    .canonicalize()
                    .map_err(|err| format!("解析任务目录失败: {err}"))?;
                return Ok(strip_verbatim(canonical));
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("创建任务目录失败 {}: {err}", dir.display())),
        }
    }
    Err("无法分配任务目录".into())
}

fn folder_view(path: &Path, documents: &Path) -> TaskFolder {
    TaskFolder {
        path: path.to_string_lossy().into_owned(),
        label: folder_label(path, documents),
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn fold_path(path: &Path) -> String {
    let text = display_path(path).trim_end_matches('/').to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn folder_label(path: &Path, documents: &Path) -> String {
    if fold_path(path) == fold_path(&documents.join(FOLDER_NAME)) {
        return "文档/AI Workbench".to_string();
    }
    let shown = display_path(path);
    let folded = fold_path(path);
    let docs = fold_path(documents);
    if folded == docs {
        return "文档".to_string();
    }
    match folded.strip_prefix(&format!("{docs}/")) {
        Some(rest) => {
            let original = &shown[shown.len() - rest.len()..];
            format!("文档/{}", original.trim_matches('/'))
        }
        None => shown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_follow_the_documents_folder() {
        let docs = Path::new(r"C:\Users\admin\Documents");
        assert_eq!(folder_label(&docs.join(FOLDER_NAME), docs), "文档/AI Workbench");
        assert_eq!(folder_label(&docs.join("Notes"), docs), "文档/Notes");
        assert_eq!(folder_label(Path::new(r"D:\work\tasks"), docs), "D:/work/tasks");
    }

    #[test]
    fn allocates_dated_slug_dirs_with_suffixes() {
        let root = tempfile::tempdir().unwrap();
        let first = allocate_chat_dir(root.path(), "Reply with pong", "2026-10-26").unwrap();
        let second = allocate_chat_dir(root.path(), "Reply with pong", "2026-10-26").unwrap();
        let zh = allocate_chat_dir(root.path(), "整理发布说明", "2026-10-26").unwrap();
        assert!(first.is_dir());
        assert!(display_path(&first).ends_with("2026-10-26/reply-with-pong"));
        assert!(display_path(&second).ends_with("reply-with-pong-2"));
        assert!(display_path(&zh).ends_with("2026-10-26/new-chat"));
    }
}
