//! 工作台项目列表。只持久化 projects.json，不扫描 Agent 会话目录。

mod store;

pub use store::{create_project_dir, normalize_import_dir, ProjectStore};
