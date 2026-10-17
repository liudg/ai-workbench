//! 工作台项目列表。只持久化 projects.json，不扫描 Agent 会话目录。

mod reveal;
mod store;

pub(crate) use reveal::reveal_project_folder;
pub use store::{create_project_dir, normalize_import_dir, ProjectStore};
