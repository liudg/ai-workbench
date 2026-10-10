//! 会话生命周期、事件日志和前端推送。
//! 只通过 Agent 适配器收发；提问卡等共享能力不在这里按 CLI 解析。

mod manager;

pub use manager::SessionManager;
