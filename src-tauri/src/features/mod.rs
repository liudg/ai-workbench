//! 按功能划分的后端。命令层只依赖各功能的公开类型，不进入适配器内部。

pub mod agents;
pub mod git;
pub mod images;
pub mod ipc;
pub mod preview;
pub mod projects;
pub mod sessions;
