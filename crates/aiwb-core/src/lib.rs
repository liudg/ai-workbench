//! AI Workbench 的领域模型和 daemon 通信协议。不依赖运行时，daemon 和应用壳共用。

pub mod attention;
pub mod chat_slug;
pub mod endpoint;
pub mod handoff;
pub mod models;
pub mod project;
pub mod rpc;
pub mod task;
pub mod timeline;

pub use endpoint::{data_dir, DaemonInfo, APP_IDENTIFIER, DAEMON_INFO_FILE};
pub use project::Project;
