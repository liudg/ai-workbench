//! 项目存储：项目列表持久化为应用数据目录下的 projects.json。
//!
//! 存储位置（Tauri app_data_dir）：
//!   Windows: %APPDATA%\\com.aiworkbench.app\\projects.json
//!   macOS:   ~/Library/Application Support/com.aiworkbench.app/projects.json
//!   Linux:   ~/.local/share/com.aiworkbench.app/projects.json

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::features::agents::{cwd_key, project_folder_keys};
use crate::models::*;

pub struct ProjectStore {
    file: PathBuf,
    projects: Mutex<Vec<Project>>,
}

impl ProjectStore {
    pub fn load(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
        let file = app_data_dir.join("projects.json");
        let projects = match fs::read_to_string(&file) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("项目数据损坏: {e}"))?,
            Err(_) => Vec::new(),
        };
        Ok(Self {
            file,
            projects: Mutex::new(projects),
        })
    }

    fn save(&self) -> Result<(), String> {
        let projects = self.projects.lock().unwrap();
        let raw = serde_json::to_string_pretty(&*projects).map_err(|e| e.to_string())?;
        fs::write(&self.file, raw).map_err(|e| format!("保存项目列表失败: {e}"))
    }

    pub fn list(&self) -> Vec<Project> {
        self.projects.lock().unwrap().clone()
    }

    fn find_project(&self, pred: impl Fn(&Project) -> bool) -> Option<Project> {
        self.projects.lock().unwrap().iter().find(|p| pred(p)).cloned()
    }

    pub fn get(&self, id: &str) -> Option<Project> {
        self.find_project(|project| project.id == id)
    }

    pub fn find_by_path(&self, path: &str) -> Option<Project> {
        self.find_project(|project| project.path == path)
    }

    pub fn add(&self, project: Project) -> Result<(), String> {
        self.projects.lock().unwrap().push(project);
        self.save()
    }

    /// 改名称和源文件夹。第一项写回 `path`。目录必须已经存在，这里不移动文件。
    pub fn update(&self, id: &str, name: &str, folders: &[String]) -> Result<Project, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("项目名不能为空".into());
        }
        let normalized = normalize_folders(folders)?;
        let updated = {
            let mut projects = self.projects.lock().unwrap();
            if folder_conflict(&projects, id, &normalized) {
                return Err("该目录已在项目列表中".into());
            }
            let project = projects
                .iter_mut()
                .find(|project| project.id == id)
                .ok_or_else(|| "项目不存在".to_string())?;
            project.name = name.to_string();
            project.path = normalized[0].clone();
            project.folders = normalized;
            project.updated_at = now_millis();
            project.clone()
        };
        self.save()?;
        Ok(updated)
    }

    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let mut projects = self.projects.lock().unwrap();
        let before = projects.len();
        projects.retain(|p| p.id != id);
        let removed = projects.len() != before;
        drop(projects);
        if removed {
            self.save()?;
        }
        Ok(removed)
    }
}

fn normalize_folders(folders: &[String]) -> Result<Vec<String>, String> {
    if folders.is_empty() {
        return Err("至少保留一个源文件夹".into());
    }
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for folder in folders {
        let (dir, _) = normalize_import_dir(folder)?;
        let key = cwd_key(&dir);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        normalized.push(dir);
    }
    if normalized.is_empty() {
        Err("至少保留一个源文件夹".into())
    } else {
        Ok(normalized)
    }
}

fn folder_conflict(projects: &[Project], id: &str, folders: &[String]) -> bool {
    let incoming: Vec<String> = folders.iter().map(|folder| cwd_key(folder)).collect();
    projects.iter().any(|project| {
        if project.id == id {
            return false;
        }
        let owned = project_folder_keys(project);
        incoming
            .iter()
            .any(|key| !key.is_empty() && owned.iter().any(|owned_key| owned_key == key))
    })
}

/// 在 parent_dir 下创建名为 name 的项目目录；可选执行 git init。
/// 返回 (目录路径, 警告信息)。
pub fn create_project_dir(
    parent_dir: &str,
    name: &str,
    init_git: bool,
) -> Result<(String, Option<String>), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    if name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err("项目名不能包含路径分隔符".into());
    }
    let parent = Path::new(parent_dir);
    if !parent.is_dir() {
        return Err(format!("目录不存在: {parent_dir}"));
    }
    let dir = parent.join(name);
    if dir.exists() {
        return Err(format!("目录已存在: {}", dir.display()));
    }
    fs::create_dir_all(&dir)
        .map_err(|e| format!("创建目录失败 {}: {e}", dir.display()))?;

    let warning = if init_git {
        let mut git = std::process::Command::new("git");
        git.arg("init").current_dir(&dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            git.creation_flags(0x08000000);
        }
        crate::encoding::apply_utf8_env_std(&mut git);
        match git.output() {
            Ok(out) if out.status.success() => None,
            Ok(out) => Some(format!(
                "git init 失败: {}",
                crate::encoding::decode_child_bytes(&out.stderr).trim()
            )),
            Err(e) => Some(format!("未找到 git，已跳过初始化（{e}）")),
        }
    } else {
        None
    };

    Ok((dir.to_string_lossy().to_string(), warning))
}

/// 校验并规范化一个待导入的目录。
pub fn normalize_import_dir(path: &str) -> Result<(String, String), String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("不是有效目录: {path}"));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("解析路径失败: {e}"))?;
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "未命名项目".into());
    Ok((strip_verbatim_prefix(&canonical.to_string_lossy()), name))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("awb-projects-{nanos}"));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample(id: &str, path: &str) -> Project {
        Project {
            id: id.into(),
            name: "旧名字".into(),
            path: path.into(),
            folders: vec![path.into()],
            default_agent: AgentKind::CodexCli,
            created_at: 1,
            updated_at: 1,
            external: false,
            standalone: false,
        }
    }

    #[test]
    fn update_persists_name_and_source_folders() {
        let scratch = TempDir::new();
        let data = TempDir::new();
        let first = scratch.0.join("app");
        let second = scratch.0.join("notes");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let store = ProjectStore::load(&data.0).unwrap();
        let path = first.to_string_lossy().to_string();
        store.add(sample("p1", &path)).unwrap();

        let updated = store
            .update(
                "p1",
                " 新名字 ",
                &[
                    path.clone(),
                    second.to_string_lossy().to_string(),
                    path.clone(),
                ],
            )
            .unwrap();
        assert_eq!(updated.name, "新名字");
        assert_eq!(updated.folders.len(), 2);
        assert_eq!(updated.path, updated.folders[0]);
        assert!(updated.folders[1].contains("notes"));

        let reloaded = ProjectStore::load(&data.0).unwrap();
        let saved = reloaded.get("p1").unwrap();
        assert_eq!(saved.name, "新名字");
        assert_eq!(saved.folders, updated.folders);
        assert_eq!(saved.path, updated.path);
    }

    #[test]
    fn update_rejects_empty_name_and_a_folder_owned_by_another_project() {
        let scratch = TempDir::new();
        let data = TempDir::new();
        let first = scratch.0.join("app");
        let second = scratch.0.join("notes");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let store = ProjectStore::load(&data.0).unwrap();
        let app = first.to_string_lossy().to_string();
        let notes = second.to_string_lossy().to_string();
        store.add(sample("p1", &app)).unwrap();
        store.add(sample("p2", &notes)).unwrap();

        assert_eq!(
            store.update("p1", "  ", &[app.clone()]).unwrap_err(),
            "项目名不能为空"
        );
        assert_eq!(
            store.update("p1", "改名", &[notes.clone()]).unwrap_err(),
            "该目录已在项目列表中"
        );
        assert_eq!(store.get("p1").unwrap().name, "旧名字");
        assert!(store.update("missing", "改名", &[app]).is_err());
    }

    #[test]
    fn old_project_json_loads_without_folders() {
        let data = TempDir::new();
        let raw = r#"[{"id":"1","name":"n","path":"/tmp/p","default_agent":"codex-cli","created_at":1,"updated_at":2}]"#;
        fs::write(data.0.join("projects.json"), raw).unwrap();
        let store = ProjectStore::load(&data.0).unwrap();
        let project = store.get("1").unwrap();
        assert!(project.folders.is_empty());
        assert_eq!(project.path, "/tmp/p");
    }
}
