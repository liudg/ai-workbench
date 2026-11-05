//! 工作台后台进程。应用壳拉起它；窗口关掉、应用更新时它继续运行。
//!
//! 同一个数据目录只允许一个实例：`daemon.lock` 拿不到就说明已经有一个在跑。
//! 启动后把端口和 token 写进 `daemon.json`，客户端据此连 `/ws`。

mod connection;
mod hub;
mod instance;
mod mcp;
mod runtime;
mod server;
mod services;
mod terminals;
mod upgrades;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aiwb_core::DaemonInfo;
use aiwb_store::{import_legacy_projects, Store, DB_FILE};

pub use hub::Hub;
pub use runtime::AdapterFactory;
pub use server::router;
pub use services::Services;

pub struct Config {
    pub data_dir: PathBuf,
    /// 0 表示随机端口。
    pub port: u16,
    /// 启动方给的构建标识，原样写回 `daemon.json`，用来判断是不是要换新版本。
    pub build: String,
}

impl Config {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            port: 0,
            build: String::new(),
        }
    }
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 已完成的会话空闲这么久、又没人在看，就关掉它的 Agent 进程。
const IDLE_RELEASE: Duration = Duration::from_secs(30 * 60);
const IDLE_SWEEP: Duration = Duration::from_secs(5 * 60);

pub async fn run(config: Config) -> Result<(), String> {
    std::fs::create_dir_all(&config.data_dir)
        .map_err(|e| format!("创建数据目录失败：{e}"))?;
    let Some(_lock) = instance::acquire(&config.data_dir)? else {
        eprintln!("已有 daemon 在运行，退出");
        return Ok(());
    };

    let store = Store::open(&config.data_dir.join(DB_FILE)).map_err(|e| e.to_string())?;
    match import_legacy_projects(&store, &config.data_dir) {
        Ok(0) => {}
        Ok(count) => eprintln!("从旧版导入了 {count} 个项目"),
        Err(err) => eprintln!("导入旧版项目失败：{err}"),
    }
    if let Err(err) = services::import_legacy_task_folder(&store, &config.data_dir) {
        eprintln!("导入旧版任务文件夹失败：{err}");
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.port))
        .await
        .map_err(|e| format!("监听端口失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let info = DaemonInfo {
        version: VERSION.to_string(),
        build: config.build,
        pid: std::process::id(),
        port,
        token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
    };
    let services = Arc::new(Services::new(
        Arc::new(store),
        info.clone(),
        config.data_dir.clone(),
    ));
    if let Err(err) = services.settle_interrupted() {
        eprintln!("整理上次没跑完的会话失败：{err}");
    }
    // 整理时记的「已停止」不算子任务的回合结束，接在它后面。
    services.start_subtask_reports();
    services.start_worktree_sweeper();
    instance::write_info(&config.data_dir, &info)?;
    eprintln!("daemon {} 已启动，端口 {port}", info.version);

    let sweeper = services.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(IDLE_SWEEP);
        loop {
            tick.tick().await;
            sweeper.release_idle_sessions(IDLE_RELEASE).await;
        }
    });

    let shutdown = services.clone();
    let ctrl_c = services.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            ctrl_c.request_shutdown();
        }
    });
    let result = axum::serve(listener, router(services.clone()))
        .with_graceful_shutdown(async move { shutdown.shutdown_requested().await })
        .await
        .map_err(|e| format!("服务出错：{e}"));
    services.finish_upgrades().await;
    services.stop_agents().await;
    services.terminals.close_all();
    instance::remove_info(&config.data_dir, info.pid);
    eprintln!("daemon 已退出");
    result
}
