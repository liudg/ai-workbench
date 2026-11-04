//! 项目：新建（建目录，可选 git init）、导入已有文件夹、改名和源文件夹、置顶、移除，以及分支。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use aiwb_core::rpc::TOPIC_PROJECTS;
use aiwb_core::Project;
use serde::{Deserialize, Serialize};

use super::{blocking, now_millis, to_value, ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateProject {
    name: String,
    parent_dir: String,
    #[serde(default)]
    init_git: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedProject {
    project: Project,
    /// 目录建好了但 git init 没成功。
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct AddProject {
    path: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateProject {
    id: String,
    name: String,
    folders: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct PinProject {
    id: String,
    pinned: bool,
}

#[derive(Deserialize)]
pub(crate) struct ProjectId {
    id: String,
}

/// 分支操作的目录：给了会话就是会话的工作目录，否则是项目主目录。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitScope {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchName {
    #[serde(flatten)]
    scope: GitScope,
    name: String,
}

impl Services {
    pub(crate) fn list_projects(&self) -> ServiceResult<Vec<Project>> {
        self.store.list_projects().map_err(|e| e.to_string())
    }

    fn project_or_err(&self, id: &str) -> ServiceResult<Project> {
        self.store
            .project(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "项目不存在".to_string())
    }

    /// 在 `parentDir` 下建名为 `name` 的目录。
    pub(crate) async fn create_project(&self, params: CreateProject) -> ServiceResult<CreatedProject> {
        let name = params.name.trim().to_string();
        let (dir, warning) = {
            let name = name.clone();
            blocking(move || create_project_dir(&params.parent_dir, &name, params.init_git)).await??
        };
        let project = self.insert_project(name, dir)?;
        Ok(CreatedProject { project, warning })
    }

    pub(crate) fn add_project(&self, params: AddProject) -> ServiceResult<Project> {
        let path = normalize_dir(&params.path)?;
        let name = params
            .name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        self.insert_project(name, path)
    }

    fn insert_project(&self, name: String, path: PathBuf) -> ServiceResult<Project> {
        let path = path.to_string_lossy().into_owned();
        self.hub.publish_with(TOPIC_PROJECTS, || {
            let mut projects = self.list_projects()?;
            if projects
                .iter()
                .any(|p| p.folders.iter().any(|folder| same_dir(folder, &path)))
            {
                return Err("这个目录已经在项目列表里".to_string());
            }
            let now = now_millis();
            let project = Project {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                path: path.clone(),
                folders: vec![path],
                pinned: false,
                created_at: now,
                updated_at: now,
            };
            self.store.insert_project(&project).map_err(|e| e.to_string())?;
            projects.push(project.clone());
            Ok((project, to_value(projects)?))
        })
    }

    /// 第一项成为主目录。不移动磁盘上的目录。
    pub(crate) fn update_project(&self, params: UpdateProject) -> ServiceResult<Project> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err("项目名不能为空".into());
        }
        let folders = normalize_folders(&params.folders)?;
        self.hub.publish_with(TOPIC_PROJECTS, || {
            let projects = self.list_projects()?;
            let taken = projects.iter().filter(|p| p.id != params.id).any(|p| {
                p.folders
                    .iter()
                    .any(|owned| folders.iter().any(|folder| same_dir(owned, folder)))
            });
            if taken {
                return Err("这个目录已经在项目列表里".to_string());
            }
            let changed = self
                .store
                .update_project(&params.id, name, &folders, now_millis())
                .map_err(|e| e.to_string())?;
            if !changed {
                return Err("项目不存在".into());
            }
            let projects = self.list_projects()?;
            let project = projects
                .iter()
                .find(|p| p.id == params.id)
                .cloned()
                .ok_or_else(|| "项目不存在".to_string())?;
            Ok((project, to_value(projects)?))
        })
    }

    pub(crate) fn pin_project(&self, params: PinProject) -> ServiceResult<bool> {
        self.hub.publish_with(TOPIC_PROJECTS, || {
            let changed = self
                .store
                .set_project_pinned(&params.id, params.pinned)
                .map_err(|e| e.to_string())?;
            Ok((changed, to_value(self.list_projects()?)?))
        })
    }

    /// 连项目下的会话（含已归档）一起删，先停掉它们的 Agent。磁盘目录和工作树不动。
    pub(crate) async fn remove_project(&self, params: ProjectId) -> ServiceResult<bool> {
        let tasks = self.store.list_tasks().map_err(|e| e.to_string())?;
        for task in tasks
            .iter()
            .filter(|task| task.project_id.as_deref() == Some(params.id.as_str()))
        {
            self.stop_task_sessions(&task.id).await?;
        }
        let removed: ServiceResult<bool> = self.hub.publish_with(TOPIC_PROJECTS, || {
            let removed = self.store.remove_project(&params.id).map_err(|e| e.to_string())?;
            Ok((removed, to_value(self.list_projects()?)?))
        });
        let removed = removed?;
        self.runtimes.publish_tasks()?;
        Ok(removed)
    }

    fn git_root(&self, scope: &GitScope) -> ServiceResult<PathBuf> {
        if let Some(session_id) = scope.session_id.as_deref() {
            return Ok(PathBuf::from(self.runtimes.workdir(session_id)?));
        }
        let project_id = scope
            .project_id
            .as_deref()
            .ok_or_else(|| "没有指定项目或会话".to_string())?;
        Ok(PathBuf::from(self.project_or_err(project_id)?.path))
    }

    pub(crate) async fn is_git_dir(&self, scope: GitScope) -> ServiceResult<bool> {
        let root = self.git_root(&scope)?;
        blocking(move || aiwb_git::inside_work_tree(&root)).await?
    }

    /// 至少有一次提交，才能从它建工作树。
    pub(crate) async fn has_commit(&self, scope: GitScope) -> ServiceResult<bool> {
        let root = self.git_root(&scope)?;
        blocking(move || aiwb_git::repo_has_commit(&root)).await?
    }

    /// 当前分支。不是仓库或分离头指针时为空。
    pub(crate) async fn current_branch(&self, scope: GitScope) -> ServiceResult<Option<String>> {
        let root = self.git_root(&scope)?;
        blocking(move || aiwb_git::current_branch(&root)).await?
    }

    pub(crate) async fn branches(&self, scope: GitScope) -> ServiceResult<aiwb_git::GitBranchMenu> {
        let root = self.git_root(&scope)?;
        blocking(move || aiwb_git::local_branch_menu(&root)).await?
    }

    pub(crate) async fn checkout_branch(&self, params: BranchName) -> ServiceResult<()> {
        let root = self.git_root(&params.scope)?;
        blocking(move || aiwb_git::checkout_local_branch(&root, &params.name)).await?
    }

    pub(crate) async fn create_branch(&self, params: BranchName) -> ServiceResult<()> {
        let root = self.git_root(&params.scope)?;
        blocking(move || aiwb_git::create_and_checkout_branch(&root, &params.name)).await?
    }
}

/// 建项目目录，可选 git init。git init 失败只给警告，目录照样留下。
fn create_project_dir(parent_dir: &str, name: &str, init_git: bool) -> ServiceResult<(PathBuf, Option<String>)> {
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    if name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err("项目名不能包含路径分隔符".into());
    }
    let parent = normalize_dir(parent_dir)?;
    let dir = parent.join(name);
    if dir.exists() {
        return Err(format!("目录已存在: {}", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败 {}: {e}", dir.display()))?;
    let warning = if init_git {
        aiwb_git::init_repository(&dir).err()
    } else {
        None
    };
    Ok((dir, warning))
}

/// 去重，保持顺序；每一项都必须是已存在的目录。
fn normalize_folders(folders: &[String]) -> ServiceResult<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for folder in folders {
        let dir = normalize_dir(folder)?.to_string_lossy().into_owned();
        if seen.insert(dir_key(&dir)) {
            normalized.push(dir);
        }
    }
    if normalized.is_empty() {
        return Err("至少保留一个源文件夹".into());
    }
    Ok(normalized)
}

/// 必须是已存在的目录。返回不带 `\\?\` 前缀的绝对路径。
pub(crate) fn normalize_dir(raw: &str) -> ServiceResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("目录不能为空".into());
    }
    let canonical = Path::new(trimmed)
        .canonicalize()
        .map_err(|_| format!("找不到目录：{trimmed}"))?;
    if !canonical.is_dir() {
        return Err(format!("不是目录：{trimmed}"));
    }
    Ok(strip_verbatim(canonical))
}

pub(crate) fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        Some(rest) => PathBuf::from(format!(r"\\{}", &rest[4..])),
        None => path,
    }
}

fn dir_key(path: &str) -> String {
    let p = path.trim_end_matches(['/', '\\']).replace('\\', "/");
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p
    }
}

fn same_dir(a: &str, b: &str) -> bool {
    dir_key(a) == dir_key(b)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use aiwb_core::DaemonInfo;
    use aiwb_store::Store;
    use serde_json::json;

    use super::*;

    fn services() -> Services {
        let info = DaemonInfo {
            version: "test".into(),
            build: String::new(),
            pid: 1,
            port: 0,
            token: "t".into(),
        };
        Services::new(Arc::new(Store::open_in_memory().unwrap()), info, std::env::temp_dir())
    }

    #[tokio::test]
    async fn add_list_remove_and_publish() {
        let services = services();
        let mut rx = services.hub.receiver();
        let dir = tempfile::tempdir().unwrap();

        let added = services
            .dispatch("projects.add", json!({ "path": dir.path().to_string_lossy() }))
            .await
            .unwrap();
        let pushed = rx.recv().await.unwrap();
        assert_eq!(pushed.topic, TOPIC_PROJECTS);
        assert_eq!(pushed.data.as_array().unwrap().len(), 1);
        assert!(!added["path"].as_str().unwrap().starts_with(r"\\?\"));
        assert_eq!(
            added["name"],
            json!(dir.path().file_name().unwrap().to_string_lossy())
        );

        let again = services
            .dispatch("projects.add", json!({ "path": dir.path().to_string_lossy() }))
            .await;
        assert!(again.is_err());

        let id = added["id"].as_str().unwrap();
        let removed = services
            .dispatch("projects.remove", json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(removed, json!(true));
        let pushed = rx.recv().await.unwrap();
        assert_eq!(pushed.topic, TOPIC_PROJECTS);
        assert_eq!(pushed.data, json!([]));
    }

    #[tokio::test]
    async fn remove_deletes_the_projects_tasks_including_archived() {
        use aiwb_core::models::{AgentKind, SessionStatus};
        use aiwb_core::task::{SessionOptions, Task, TaskSession, TaskWorkspace};

        let services = services();
        let dir = tempfile::tempdir().unwrap();
        let added = services
            .dispatch("projects.add", json!({ "path": dir.path().to_string_lossy() }))
            .await
            .unwrap();
        let id = added["id"].as_str().unwrap().to_string();
        let task = Task {
            id: "t1".into(),
            project_id: Some(id.clone()),
            title: "旧会话".into(),
            workspace: TaskWorkspace::Root,
            pinned: false,
            archived_at: Some(5),
            created_at: 1,
            updated_at: 5,
            parent_task_id: None,
        };
        let session = TaskSession {
            id: "t1-s".into(),
            task_id: "t1".into(),
            agent: AgentKind::CodexCli,
            native_id: None,
            status: SessionStatus::Completed,
            options: SessionOptions::default(),
            created_at: 1,
            updated_at: 1,
        };
        services.store.insert_task(&task, &session).unwrap();

        let removed = services
            .dispatch("projects.remove", json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(removed, json!(true));
        assert!(services.store.list_tasks().unwrap().is_empty());
        assert!(services.list_projects().unwrap().is_empty());
    }

    #[tokio::test]
    async fn add_rejects_missing_dir() {
        let services = services();
        let err = services
            .dispatch("projects.add", json!({ "path": "Z:/definitely/not/here" }))
            .await
            .unwrap_err();
        assert!(err.contains("找不到目录"));
    }

    #[tokio::test]
    async fn create_makes_the_folder_and_rejects_existing_names() {
        let services = services();
        let parent = tempfile::tempdir().unwrap();
        let created = services
            .dispatch(
                "projects.create",
                json!({ "name": "demo", "parentDir": parent.path().to_string_lossy(), "initGit": false }),
            )
            .await
            .unwrap();
        assert!(parent.path().join("demo").is_dir());
        assert_eq!(created["project"]["name"], json!("demo"));
        assert!(created.get("warning").is_none());

        let again = services
            .dispatch(
                "projects.create",
                json!({ "name": "demo", "parentDir": parent.path().to_string_lossy() }),
            )
            .await
            .unwrap_err();
        assert!(again.contains("目录已存在"));
        let bad = services
            .dispatch(
                "projects.create",
                json!({ "name": "a/b", "parentDir": parent.path().to_string_lossy() }),
            )
            .await
            .unwrap_err();
        assert!(bad.contains("路径分隔符"));
    }

    #[tokio::test]
    async fn update_folders_pin_and_reject_taken_folders() {
        let services = services();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = services
            .dispatch("projects.add", json!({ "path": a.path().to_string_lossy() }))
            .await
            .unwrap();
        let second = services
            .dispatch("projects.add", json!({ "path": b.path().to_string_lossy() }))
            .await
            .unwrap();
        let id = first["id"].as_str().unwrap();

        let taken = services
            .dispatch(
                "projects.update",
                json!({ "id": id, "name": "A", "folders": [a.path().to_string_lossy(), second["path"]] }),
            )
            .await
            .unwrap_err();
        assert!(taken.contains("已经在项目列表里"));

        let extra = tempfile::tempdir().unwrap();
        let updated = services
            .dispatch(
                "projects.update",
                json!({ "id": id, "name": " 新名 ", "folders": [extra.path().to_string_lossy(), a.path().to_string_lossy(), extra.path().to_string_lossy()] }),
            )
            .await
            .unwrap();
        assert_eq!(updated["name"], json!("新名"));
        assert_eq!(updated["folders"].as_array().unwrap().len(), 2);
        assert_eq!(updated["path"], updated["folders"][0]);

        services
            .dispatch("projects.setPinned", json!({ "id": id, "pinned": true }))
            .await
            .unwrap();
        let listed = services.list_projects().unwrap();
        assert!(listed.iter().find(|p| p.id == id).unwrap().pinned);
    }

    #[test]
    fn same_dir_ignores_separators_and_trailing_slash() {
        assert!(same_dir("C:\\a\\b\\", "C:/a/b"));
    }
}
