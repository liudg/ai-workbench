//! 从旧版 `projects.json` 导入项目，只做一次。独立聊天的隐藏项目不导入。

use std::path::Path;

use aiwb_core::Project;
use serde::Deserialize;

use crate::{Store, StoreResult};

const IMPORTED_KEY: &str = "legacy_projects_imported";

/// 旧版 `ProjectStore` 的字段，snake_case。
#[derive(Deserialize)]
struct LegacyProject {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    folders: Vec<String>,
    default_agent: String,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    standalone: bool,
}

/// 返回这次导入的项目数。已经导入过、或者没有旧文件时返回 0。
pub fn import_legacy_projects(store: &Store, data_dir: &Path) -> StoreResult<usize> {
    if store.meta(IMPORTED_KEY)?.is_some() {
        return Ok(0);
    }
    let raw = match std::fs::read_to_string(data_dir.join("projects.json")) {
        Ok(raw) => raw,
        Err(_) => {
            store.set_meta(IMPORTED_KEY, "none")?;
            return Ok(0);
        }
    };
    let legacy: Vec<LegacyProject> = match serde_json::from_str(&raw) {
        Ok(list) => list,
        Err(err) => {
            // 坏文件不挡启动，也不标记已导入，修好后下次还能导。
            eprintln!("旧版 projects.json 无法解析，跳过导入：{err}");
            return Ok(0);
        }
    };
    let mut imported = 0;
    for item in legacy.into_iter().filter(|item| !item.standalone) {
        let folders = if item.folders.is_empty() {
            vec![item.path.clone()]
        } else {
            item.folders
        };
        let project = Project {
            id: item.id,
            name: item.name,
            path: folders[0].clone(),
            folders,
            default_agent: item.default_agent,
            created_at: item.created_at,
            updated_at: item.updated_at,
        };
        if store.insert_project(&project)? {
            imported += 1;
        }
    }
    store.set_meta(IMPORTED_KEY, "done")?;
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_once_and_skips_standalone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("projects.json"),
            r#"[
              {"id":"p1","name":"One","path":"C:\\one","default_agent":"codex-cli","created_at":1,"updated_at":1,"external":false},
              {"id":"p2","name":"Two","path":"C:\\two","folders":["C:\\two","C:\\two-b"],"default_agent":"claude-code","created_at":2,"updated_at":3},
              {"id":"c1","name":"Chat","path":"C:\\chat","default_agent":"codex-cli","created_at":4,"updated_at":4,"standalone":true}
            ]"#,
        )
        .unwrap();
        let store = Store::open_in_memory().unwrap();

        assert_eq!(import_legacy_projects(&store, dir.path()).unwrap(), 2);
        let projects = store.list_projects().unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].folders, vec!["C:\\one".to_string()]);
        assert_eq!(projects[1].folders.len(), 2);
        assert_eq!(projects[1].default_agent, "claude-code");

        // 用户在新版删掉的项目，不会因为旧文件还在又回来。
        store.remove_project("p1").unwrap();
        assert_eq!(import_legacy_projects(&store, dir.path()).unwrap(), 0);
        assert_eq!(store.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn missing_file_marks_done() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_memory().unwrap();
        assert_eq!(import_legacy_projects(&store, dir.path()).unwrap(), 0);
        assert_eq!(store.meta(IMPORTED_KEY).unwrap().as_deref(), Some("none"));
    }

    #[test]
    fn broken_file_retries_later() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("projects.json"), "{not json").unwrap();
        let store = Store::open_in_memory().unwrap();
        assert_eq!(import_legacy_projects(&store, dir.path()).unwrap(), 0);
        assert_eq!(store.meta(IMPORTED_KEY).unwrap(), None);
    }
}
