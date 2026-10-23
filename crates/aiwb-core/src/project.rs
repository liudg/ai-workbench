use serde::{Deserialize, Serialize};

/// 一个本地项目。任务都挂在项目下。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// 主目录的绝对路径，等于 `folders[0]`。
    pub path: String,
    pub folders: Vec<String>,
    pub default_agent: String,
    pub created_at: i64,
    pub updated_at: i64,
}
