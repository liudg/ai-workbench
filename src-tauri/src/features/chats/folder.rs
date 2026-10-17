//! 独立聊天的任务根目录，以及首发时创建的真实工作目录。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::features::projects::{normalize_import_dir, ProjectStore};
use crate::models::{now_millis, strip_verbatim_prefix, AgentKind, Project};

use super::slug::{candidate_name, chat_slug};

const FOLDER_NAME: &str = "AI Workbench";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFolderView {
    pub path: String,
    pub label: String,
}

#[derive(Serialize, Deserialize)]
struct TaskFolderFile {
    path: Option<String>,
}

pub struct TaskFolderStore {
    file: PathBuf,
    custom: Mutex<Option<String>>,
}

impl TaskFolderStore {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
        let file = data_dir.join("task-folder.json");
        let custom = match fs::read_to_string(&file) {
            Ok(raw) => {
                let parsed: TaskFolderFile =
                    serde_json::from_str(&raw).map_err(|e| format!("任务文件夹设置损坏: {e}"))?;
                parsed.path.filter(|path| !path.trim().is_empty())
            }
            Err(_) => None,
        };
        Ok(Self {
            file,
            custom: Mutex::new(custom),
        })
    }

    fn save(&self) -> Result<(), String> {
        let path = self.custom.lock().unwrap().clone();
        let raw = serde_json::to_string_pretty(&TaskFolderFile { path }).map_err(|e| e.to_string())?;
        fs::write(&self.file, raw).map_err(|e| format!("保存任务文件夹失败: {e}"))
    }

    pub fn current(&self, documents: &Path) -> PathBuf {
        match self.custom.lock().unwrap().clone() {
            Some(path) => PathBuf::from(path),
            None => default_task_folder(documents),
        }
    }

    pub fn set_path(&self, path: &str) -> Result<(), String> {
        let (dir, _) = normalize_import_dir(path)?;
        *self.custom.lock().unwrap() = Some(dir);
        self.save()
    }

    pub fn view(&self, documents: &Path) -> TaskFolderView {
        let path = self.current(documents);
        TaskFolderView {
            label: task_folder_label(&path, documents),
            path: path.to_string_lossy().to_string(),
        }
    }
}

pub fn documents_dir(resolved: Option<PathBuf>) -> PathBuf {
    if let Some(path) = resolved {
        if path.is_dir() {
            return path;
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let docs = PathBuf::from(profile).join("Documents");
        if docs.is_dir() {
            return docs;
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let docs = PathBuf::from(home).join("Documents");
        if docs.is_dir() {
            return docs;
        }
    }
    std::env::temp_dir().join("Documents")
}

pub fn default_task_folder(documents: &Path) -> PathBuf {
    documents.join(FOLDER_NAME)
}

pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn task_folder_label(path: &Path, documents: &Path) -> String {
    let default = default_task_folder(documents);
    if same_path(path, &default) {
        return "文档/AI Workbench".to_string();
    }
    if let Some(rest) = suffix_under(path, documents) {
        if rest.is_empty() {
            return "文档".to_string();
        }
        return format!("文档/{rest}");
    }
    display_path(path)
}

/// 在任务根下创建 `YYYY-MM-DD/<slug>`，并记成不进项目分组的项目。
pub fn provision_standalone_chat(
    store: &ProjectStore,
    root: &Path,
    prompt: &str,
    agent: AgentKind,
    today: &str,
) -> Result<Project, String> {
    let dir = allocate_chat_dir(root, prompt, today)?;
    let path = canonical_path(&dir)?;
    let name = Path::new(&path)
        .file_name()
        .map(|item| item.to_string_lossy().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| chat_slug(prompt));
    let now = now_millis();
    let project = Project {
        id: crate::models::new_id(),
        name,
        path: path.clone(),
        folders: vec![path],
        default_agent: agent,
        created_at: now,
        updated_at: now,
        external: false,
        standalone: true,
    };
    if let Err(err) = store.add(project.clone()) {
        let _ = fs::remove_dir(&dir);
        return Err(err);
    }
    Ok(project)
}

pub fn rollback_standalone(store: &ProjectStore, project: &Project) {
    if !project.standalone {
        return;
    }
    let _ = store.remove(&project.id);
    remove_empty_dir(&project.path);
}

pub fn remove_empty_dir(path: &str) {
    let dir = Path::new(path);
    if dir.is_dir() {
        let _ = fs::remove_dir(dir);
    }
}

fn allocate_chat_dir(root: &Path, prompt: &str, today: &str) -> Result<PathBuf, String> {
    let day = root.join(today);
    fs::create_dir_all(&day).map_err(|err| format!("创建任务目录失败 {}: {err}", day.display()))?;
    let slug = chat_slug(prompt);
    for index in 0..1000 {
        let dir = day.join(candidate_name(&slug, index));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("创建任务目录失败 {}: {err}", dir.display())),
        }
    }
    Err("无法分配任务目录".into())
}

fn canonical_path(dir: &Path) -> Result<String, String> {
    let canonical = dir
        .canonicalize()
        .map_err(|err| format!("解析任务目录失败: {err}"))?;
    Ok(strip_verbatim_prefix(&canonical.to_string_lossy()))
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

fn same_path(left: &Path, right: &Path) -> bool {
    fold_path(left) == fold_path(right)
}

fn suffix_under(path: &Path, documents: &Path) -> Option<String> {
    let path_display = display_path(path);
    let path_fold = fold_path(path);
    let docs_fold = fold_path(documents);
    if path_fold == docs_fold {
        return Some(String::new());
    }
    let prefix = format!("{docs_fold}/");
    let rest = path_fold.strip_prefix(&prefix)?;
    let original = &path_display[path_display.len() - rest.len()..];
    Some(original.trim_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "awb-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn default_label_uses_documents_name() {
        let docs = Path::new(r"C:\Users\admin\Documents");
        let path = default_task_folder(docs);
        assert_eq!(task_folder_label(&path, docs), "文档/AI Workbench");
    }

    #[test]
    fn other_documents_folder_keeps_the_tail() {
        let docs = Path::new(r"C:\Users\admin\Documents");
        assert_eq!(
            task_folder_label(&docs.join("Notes"), docs),
            "文档/Notes"
        );
    }

    #[test]
    fn outside_documents_shows_the_path() {
        let docs = Path::new(r"C:\Users\admin\Documents");
        assert_eq!(
            task_folder_label(Path::new(r"D:\work\tasks"), docs),
            "D:/work/tasks"
        );
    }

    #[test]
    fn missing_file_uses_the_default_root() {
        let data = temp_dir("task-default");
        let docs = temp_dir("docs");
        let store = TaskFolderStore::load(&data).unwrap();
        assert_eq!(store.current(&docs), docs.join(FOLDER_NAME));
        assert_eq!(store.view(&docs).label, "文档/AI Workbench");
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(docs);
    }

    #[test]
    fn custom_root_round_trips() {
        let data = temp_dir("task-custom");
        let docs = temp_dir("docs-custom");
        let chosen = temp_dir("chosen");
        let store = TaskFolderStore::load(&data).unwrap();
        store.set_path(chosen.to_str().unwrap()).unwrap();
        let again = TaskFolderStore::load(&data).unwrap();
        assert!(same_path(&again.current(&docs), &chosen));
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(docs);
        let _ = fs::remove_dir_all(chosen);
    }

    #[test]
    fn provision_creates_a_real_directory_and_hides_it_from_project_names() {
        let data = temp_dir("prov");
        let root = temp_dir("root");
        let store = ProjectStore::load(&data).unwrap();
        let project = provision_standalone_chat(
            &store,
            &root,
            "Reply with pong",
            AgentKind::CodexCli,
            "2026-10-16",
        )
        .unwrap();
        assert!(project.standalone);
        assert!(Path::new(&project.path).is_dir());
        assert!(project.path.replace('\\', "/").ends_with("2026-10-16/reply-with-pong"));
        let second = provision_standalone_chat(
            &store,
            &root,
            "Reply with pong",
            AgentKind::ClaudeCode,
            "2026-10-16",
        )
        .unwrap();
        assert!(second.path.replace('\\', "/").ends_with("reply-with-pong-2"));
        assert_eq!(store.list().len(), 2);
        rollback_standalone(&store, &project);
        assert!(store.get(&project.id).is_none());
        assert!(!Path::new(&project.path).exists());
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn chinese_prompt_uses_new_chat() {
        let data = temp_dir("zh");
        let root = temp_dir("zh-root");
        let store = ProjectStore::load(&data).unwrap();
        let project =
            provision_standalone_chat(&store, &root, "整理发布说明", AgentKind::CodexCli, "2026-10-16")
                .unwrap();
        assert!(project.path.replace('\\', "/").ends_with("2026-10-16/new-chat"));
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn old_project_json_is_not_standalone() {
        let raw = r#"{"id":"1","name":"n","path":"p","default_agent":"codex-cli","created_at":1,"updated_at":2}"#;
        let project: Project = serde_json::from_str(raw).unwrap();
        assert!(!project.standalone);
        assert!(!project.external);
    }
}
