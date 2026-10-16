//! 领域模型：项目、会话、会话事件。
//! 与前端 `src/types` 一一对应（serde 序列化即 IPC 协议）。
//!
//! `agent` 是种类，`session` 是项目和会话，`event` 是时间线，`catalog` 是能力与安装结果。

mod agent;
mod catalog;
mod event;
mod session;
mod subscription;

pub use agent::*;
pub use catalog::*;
pub use event::*;
pub use session::*;
pub use subscription::*;

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
