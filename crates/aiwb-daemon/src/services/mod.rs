//! 所有对外能力都是这里的方法。界面、命令面板、快捷键、以后的本地 MCP 都走 [`Services::dispatch`]。

mod files;
mod projects;
mod sessions;
mod tasks;

use std::path::PathBuf;
use std::sync::Arc;

use aiwb_core::rpc::{TOPIC_PROJECTS, TOPIC_SESSION_PREFIX, TOPIC_TASKS};
use aiwb_core::DaemonInfo;
use aiwb_store::Store;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::hub::Hub;
use crate::runtime::{AdapterFactory, Runtimes};

pub type ServiceResult<T> = Result<T, String>;

pub struct Services {
    pub(crate) store: Arc<Store>,
    pub(crate) hub: Arc<Hub>,
    pub(crate) runtimes: Arc<Runtimes>,
    /// 文件路径索引和文件名筛选的序号。按工作目录共用。
    pub(crate) indexes: aiwb_files::IndexHub,
    pub(crate) filters: aiwb_files::FilterHub,
    /// 任务工作树放在这里，每个任务一个子目录。
    pub(crate) worktree_root: PathBuf,
    info: DaemonInfo,
    shutdown: watch::Sender<bool>,
}

impl Services {
    pub fn new(store: Arc<Store>, info: DaemonInfo, data_dir: PathBuf) -> Self {
        Self::with_adapters(store, info, data_dir, Arc::new(aiwb_agents::adapter_for))
    }

    /// 测试用：换掉真实的 Agent CLI。
    pub fn with_adapters(
        store: Arc<Store>,
        info: DaemonInfo,
        data_dir: PathBuf,
        adapters: AdapterFactory,
    ) -> Self {
        let hub = Arc::new(Hub::new());
        Self {
            runtimes: Arc::new(Runtimes::new(store.clone(), hub.clone(), adapters)),
            store,
            hub,
            indexes: aiwb_files::IndexHub::default(),
            filters: aiwb_files::FilterHub::default(),
            worktree_root: data_dir.join("worktrees"),
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

    /// 启动时调用一次：上次退出时没跑完的会话记成已停止。
    pub fn settle_interrupted(&self) -> ServiceResult<()> {
        self.runtimes.settle_interrupted()
    }

    pub fn request_shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub async fn shutdown_requested(&self) {
        let mut rx = self.shutdown.subscribe();
        let _ = rx.wait_for(|stop| *stop).await;
    }

    /// 退出前关掉所有 Agent 进程。
    pub async fn stop_agents(&self) {
        self.runtimes.stop_all().await;
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
            "agents.profiles" => to_value(aiwb_agents::agent_profiles()),
            "agents.permissionMenu" => to_value(self.draft_permission_menu(parse(params)?)),
            "agents.subscriptionUsage" => to_value(self.subscription_usage(parse(params)?).await?),
            "tasks.list" => to_value(self.store.task_entries().map_err(|e| e.to_string())?),
            "tasks.create" => to_value(self.create_task(parse(params)?).await?),
            "tasks.rename" => to_value(self.rename_task(parse(params)?)?),
            "tasks.archive" => to_value(self.archive_task(parse(params)?).await?),
            "tasks.remove" => to_value(self.remove_task(parse(params)?).await?),
            "sessions.send" => to_value(self.send(parse(params)?).await?),
            "sessions.interrupt" => to_value(self.interrupt(parse(params)?).await?),
            "sessions.answer" => to_value(self.answer(parse(params)?).await?),
            "sessions.updateQueued" => to_value(self.update_queued(parse(params)?).await?),
            "sessions.removeQueued" => to_value(self.remove_queued(parse(params)?).await?),
            "sessions.steerQueued" => to_value(self.steer_queued(parse(params)?).await?),
            "sessions.setOptions" => to_value(self.set_options(parse(params)?).await?),
            "sessions.catalog" => to_value(self.catalog(parse(params)?).await?),
            "sessions.permissionMenu" => to_value(self.permission_menu(parse(params)?).await?),
            "sessions.stop" => to_value(self.stop_session(parse(params)?).await?),
            "sessions.diffScopes" => to_value(self.diff_scopes(parse(params)?).await?),
            "sessions.diff" => to_value(self.diff(parse(params)?).await?),
            "sessions.readFile" => to_value(self.read_file(parse(params)?).await?),
            "sessions.readImage" => to_value(self.read_image(parse(params)?).await?),
            "sessions.listDir" => to_value(self.list_dir(parse(params)?).await?),
            "sessions.filterPaths" => to_value(self.filter_paths(parse(params)?).await?),
            "sessions.searchFiles" => to_value(self.search_files(parse(params)?).await?),
            "sessions.submitAnnotation" => to_value(self.submit_annotation(parse(params)?).await?),
            "sessions.isGit" => to_value(self.is_git(parse(params)?).await?),
            "sessions.reviewTargets" => to_value(self.review_targets(parse(params)?).await?),
            "sessions.startReview" => to_value(self.start_review(parse(params)?).await?),
            _ => Err(format!("没有这个方法：{method}")),
        }
    }

    /// 主题的当前值。不认识的主题返回错误。会话主题按 `fromRev` 只给之后的事件。
    pub fn snapshot(&self, topic: &str, params: &Value) -> ServiceResult<Value> {
        match topic {
            TOPIC_PROJECTS => to_value(self.list_projects()?),
            TOPIC_TASKS => to_value(self.store.task_entries().map_err(|e| e.to_string())?),
            _ => match topic.strip_prefix(TOPIC_SESSION_PREFIX) {
                Some(session_id) => {
                    let from_rev = params.get("fromRev").and_then(Value::as_u64).unwrap_or(0);
                    self.runtimes.snapshot(session_id, from_rev)
                }
                None => Err(format!("没有这个主题：{topic}")),
            },
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
    aiwb_core::models::now_millis()
}
