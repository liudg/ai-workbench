//! 所有对外能力都是这里的方法。界面、命令面板、快捷键、以后的本地 MCP 都走 [`Services::dispatch`]。

mod projects;

use std::sync::Arc;

use aiwb_core::rpc::TOPIC_PROJECTS;
use aiwb_core::DaemonInfo;
use aiwb_store::Store;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::hub::Hub;

pub type ServiceResult<T> = Result<T, String>;

pub struct Services {
    pub(crate) store: Arc<Store>,
    pub(crate) hub: Hub,
    info: DaemonInfo,
    shutdown: watch::Sender<bool>,
}

impl Services {
    pub fn new(store: Arc<Store>, info: DaemonInfo) -> Self {
        Self {
            store,
            hub: Hub::new(),
            info,
            shutdown: watch::channel(false).0,
        }
    }

    pub fn info(&self) -> &DaemonInfo {
        &self.info
    }

    pub fn hub(&self) -> &Hub {
        &self.hub
    }

    pub fn request_shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub async fn shutdown_requested(&self) {
        let mut rx = self.shutdown.subscribe();
        let _ = rx.wait_for(|stop| *stop).await;
    }

    pub async fn dispatch(&self, method: &str, params: Value) -> ServiceResult<Value> {
        match method {
            "daemon.info" => Ok(json!({ "version": self.info.version, "pid": self.info.pid })),
            "daemon.shutdown" => {
                self.request_shutdown();
                Ok(Value::Null)
            }
            "projects.list" => to_value(self.list_projects()?),
            "projects.add" => to_value(self.add_project(parse(params)?)?),
            "projects.remove" => to_value(self.remove_project(parse(params)?)?),
            _ => Err(format!("没有这个方法：{method}")),
        }
    }

    /// 主题的当前值。不认识的主题返回错误。
    pub fn snapshot(&self, topic: &str) -> ServiceResult<Value> {
        match topic {
            TOPIC_PROJECTS => to_value(self.list_projects()?),
            _ => Err(format!("没有这个主题：{topic}")),
        }
    }
}

fn parse<T: DeserializeOwned>(params: Value) -> ServiceResult<T> {
    serde_json::from_value(params).map_err(|e| format!("参数不对：{e}"))
}

fn to_value<T: serde::Serialize>(value: T) -> ServiceResult<Value> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
