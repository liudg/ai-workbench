//! 启动会话的上下文。字段对所有 Agent 通用，协议差异留在适配器里。

/// 启动一个会话所需的上下文。
#[derive(Debug, Clone)]
pub struct SessionContext {
    /// 项目根目录；真实 CLI 的工作目录。
    pub project_path: String,
    /// 创建会话时的权限档位。缺省由适配器按自己的权限模式解释。
    pub access_mode: Option<String>,
    /// 要恢复的原生会话 id。空表示新会话。
    pub resume_native_id: Option<String>,
    /// 适配器扩展。是否写入可 resume 的会话列表由各适配器读取 `persist`。
    pub options: serde_json::Value,
}

impl SessionContext {
    pub fn flag(&self, key: &str) -> bool {
        self.options
            .get(key)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }
}
