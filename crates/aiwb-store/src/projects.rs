use aiwb_core::Project;
use rusqlite::{params, OptionalExtension, Row};

use crate::{Store, StoreError, StoreResult};

fn from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    let folders_json: String = row.get("folders")?;
    let folders: Vec<String> = serde_json::from_str(&folders_json).unwrap_or_default();
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        path: folders.first().cloned().unwrap_or_default(),
        folders,
        pinned: row.get("pinned")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl Store {
    /// 按创建时间排列。
    pub fn list_projects(&self) -> StoreResult<Vec<Project>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM project ORDER BY created_at, id")?;
        let rows = stmt.query_map([], from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 已存在同 id 的项目时不覆盖，返回 false。
    pub fn insert_project(&self, project: &Project) -> StoreResult<bool> {
        if project.folders.is_empty() || project.folders[0] != project.path {
            return Err(StoreError::Invalid("项目目录和 folders 第一项不一致".into()));
        }
        let folders = serde_json::to_string(&project.folders).expect("serialize folders");
        let changed = self.conn().execute(
            "INSERT OR IGNORE INTO project (id, name, folders, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project.id,
                project.name,
                folders,
                project.pinned,
                project.created_at,
                project.updated_at
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn project(&self, id: &str) -> StoreResult<Option<Project>> {
        Ok(self
            .conn()
            .query_row("SELECT * FROM project WHERE id = ?1", [id], from_row)
            .optional()?)
    }

    /// 改名称和源文件夹。第一项是主目录。
    pub fn update_project(&self, id: &str, name: &str, folders: &[String], now: i64) -> StoreResult<bool> {
        if folders.is_empty() {
            return Err(StoreError::Invalid("至少保留一个源文件夹".into()));
        }
        let folders = serde_json::to_string(folders).expect("serialize folders");
        Ok(self.conn().execute(
            "UPDATE project SET name = ?2, folders = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, name, folders, now],
        )? > 0)
    }

    pub fn set_project_pinned(&self, id: &str, pinned: bool) -> StoreResult<bool> {
        Ok(self
            .conn()
            .execute("UPDATE project SET pinned = ?2 WHERE id = ?1", params![id, pinned])?
            > 0)
    }

    pub fn remove_project(&self, id: &str) -> StoreResult<bool> {
        Ok(self.conn().execute("DELETE FROM project WHERE id = ?1", [id])? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, path: &str, created_at: i64) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            path: path.into(),
            folders: vec![path.into()],
            pinned: false,
            created_at,
            updated_at: created_at,
        }
    }

    #[test]
    fn insert_list_remove() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.insert_project(&sample("b", "/b", 2)).unwrap());
        assert!(store.insert_project(&sample("a", "/a", 1)).unwrap());
        assert!(!store.insert_project(&sample("a", "/other", 3)).unwrap());

        let listed = store.list_projects().unwrap();
        assert_eq!(listed.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(listed[0].path, "/a");

        assert!(store.remove_project("a").unwrap());
        assert!(!store.remove_project("a").unwrap());
        assert_eq!(store.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn update_and_pin() {
        let store = Store::open_in_memory().unwrap();
        store.insert_project(&sample("a", "/a", 1)).unwrap();
        let folders = vec!["/a2".to_string(), "/b".to_string()];
        assert!(store.update_project("a", "新名", &folders, 5).unwrap());
        assert!(store.set_project_pinned("a", true).unwrap());
        let project = store.project("a").unwrap().unwrap();
        assert_eq!(project.name, "新名");
        assert_eq!(project.path, "/a2");
        assert_eq!(project.folders, folders);
        assert!(project.pinned);
        assert_eq!(project.updated_at, 5);
        assert!(!store.update_project("missing", "x", &folders, 5).unwrap());
    }

    #[test]
    fn rejects_mismatched_path() {
        let store = Store::open_in_memory().unwrap();
        let mut project = sample("a", "/a", 1);
        project.path = "/x".into();
        assert!(store.insert_project(&project).is_err());
    }

    #[test]
    fn reopening_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        Store::open(&path).unwrap().insert_project(&sample("a", "/a", 1)).unwrap();
        assert_eq!(Store::open(&path).unwrap().list_projects().unwrap().len(), 1);
    }
}
