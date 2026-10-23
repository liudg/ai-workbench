//! daemon 在数据目录里留下的连接信息。应用壳和网页预览都靠它找到 daemon。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 与 Tauri `identifier` 相同，数据目录和旧版共用。
pub const APP_IDENTIFIER: &str = "com.aiworkbench.app";

/// daemon 启动后写入、退出时删除。
pub const DAEMON_INFO_FILE: &str = "daemon.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub version: String,
    /// 启动方给的构建标识。和应用自带的不一致时，应用会换掉这个 daemon。
    #[serde(default)]
    pub build: String,
    pub pid: u32,
    pub port: u16,
    /// 每次启动随机生成。WebSocket 和 HTTP 控制接口都要带上。
    pub token: String,
}

impl DaemonInfo {
    pub fn ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}/ws", self.port)
    }
}

/// 应用数据目录。`AIWB_DATA_DIR` 优先，否则与 Tauri `app_data_dir` 一致。
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AIWB_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                let home = PathBuf::from(home);
                if cfg!(target_os = "macos") {
                    home.join("Library/Application Support")
                } else {
                    std::env::var_os("XDG_DATA_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".local/share"))
                }
            })
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join(APP_IDENTIFIER)
}
