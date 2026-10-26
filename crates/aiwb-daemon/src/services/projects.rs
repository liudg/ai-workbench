use std::path::{Path, PathBuf};

use aiwb_core::rpc::TOPIC_PROJECTS;
use aiwb_core::Project;
use serde::Deserialize;

use super::{now_millis, to_value, ServiceResult, Services};

#[derive(Deserialize)]
pub(crate) struct AddProject {
    path: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct RemoveProject {
    id: String,
}

const DEFAULT_AGENT: &str = "codex-cli";

impl Services {
    pub(crate) fn list_projects(&self) -> ServiceResult<Vec<Project>> {
        self.store.list_projects().map_err(|e| e.to_string())
    }

    pub(crate) fn add_project(&self, params: AddProject) -> ServiceResult<Project> {
        let path = normalize_dir(&params.path)?;
        let name = params
            .name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
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
                default_agent: DEFAULT_AGENT.into(),
                created_at: now,
                updated_at: now,
            };
            self.store.insert_project(&project).map_err(|e| e.to_string())?;
            projects.push(project.clone());
            Ok((project, to_value(projects)?))
        })
    }

    /// 还有任务的项目不移除，免得把任务记录一起删掉。
    pub(crate) fn remove_project(&self, params: RemoveProject) -> ServiceResult<bool> {
        let tasks = self.store.list_tasks().map_err(|e| e.to_string())?;
        let count = tasks.iter().filter(|task| task.project_id == params.id).count();
        if count > 0 {
            return Err(format!("这个项目下还有 {count} 个任务，先删掉它们再移除项目"));
        }
        self.hub.publish_with(TOPIC_PROJECTS, || {
            let removed = self.store.remove_project(&params.id).map_err(|e| e.to_string())?;
            Ok((removed, to_value(self.list_projects()?)?))
        })
    }
}

/// 必须是已存在的目录。返回不带 `\\?\` 前缀的绝对路径。
fn normalize_dir(raw: &str) -> ServiceResult<PathBuf> {
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
    let text = canonical.to_string_lossy();
    Ok(match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        Some(rest) => PathBuf::from(format!(r"\\{}", &rest[4..])),
        None => canonical,
    })
}

fn same_dir(a: &str, b: &str) -> bool {
    let key = |p: &str| {
        let p = p.trim_end_matches(['/', '\\']).replace('\\', "/");
        if cfg!(windows) {
            p.to_lowercase()
        } else {
            p
        }
    };
    key(a) == key(b)
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
    async fn add_rejects_missing_dir() {
        let services = services();
        let err = services
            .dispatch("projects.add", json!({ "path": "Z:/definitely/not/here" }))
            .await
            .unwrap_err();
        assert!(err.contains("找不到目录"));
    }

    #[test]
    fn same_dir_ignores_separators_and_trailing_slash() {
        assert!(same_dir("C:\\a\\b\\", "C:/a/b"));
    }
}
