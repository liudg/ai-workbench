//! 适配器运行时错误。会话管理和界面只看这些错误，不解析某一种 CLI 的协议。

/// 适配器运行时错误。
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("agent 正忙，稍后再试")]
    Busy,
    #[error("存在待回答的提问，请先处理")]
    PendingPrompt,
    #[error("提问不存在或已被回答: {0}")]
    UnknownPrompt(String),
    #[error("会话已关闭")]
    Closed,
    #[error("{0} 的会话协议未接入工作台，不能新建会话")]
    NotLinked(&'static str),
    /// 真实 CLI 适配器（进程 / 解析失败）使用。
    #[error("agent 运行时错误: {0}")]
    Runtime(String),
}
