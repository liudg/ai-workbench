//! 项目存储：项目列表持久化为应用数据目录下的 projects.json。
//!
//! 存储位置（Tauri app_data_dir）：
//!   Windows: %APPDATA%\\com.aiworkbench.app\\projects.json
//!   macOS:   ~/Library/Application Support/com.aiworkbench.app/projects.json
//!   Linux:   ~/.local/share/com.aiworkbench.app/projects.json

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
