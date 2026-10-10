//! Tauri invoke 入口。按功能拆开，避免命令层和某个 CLI 适配器缠在一起。

pub mod agents;
pub mod host;
pub mod projects;
pub mod sessions;
