//! 冷启动时取模型目录的重试。
//!
//! `agent acp` 要联网才拿得到模型目录，网络抖一下有三种表现（2026-11-06 对 2026.10.22-27dcf5f
//! 在代理上注入故障验证，`3635.index.js`、`2232.index.js`）：
//! - 初始化服务时断：`ensureSharedServices` 吞掉原因，报 `Failed to initialize ACP services`。
//! - 服务起来后断：`getAcpAvailableModels` 吞掉异常，回空列表。
//! - 连接挂住：这一步没有超时，一直不回，同一进程后面的请求也跟着卡住。
//!
//! 前两种不缓存，同一进程等一下再取就好；卡住的只能换进程。启动时那次模型初始化失败会留在进程里，
//! 所以再取还不行也换进程。

use std::future::Future;
use std::time::Duration;

use crate::AgentError;

/// 同一进程里回空或报服务不可用后再取几次。
pub const REFETCHES: u32 = 3;
/// 第 n 次再取前等 n 倍。
pub const REFETCH_WAIT: Duration = Duration::from_secs(1);
/// 一次打开最多起几个进程。
pub const PROCESSES: u32 = 3;
const RESTART_WAIT: Duration = Duration::from_secs(1);

/// 没拿到模型目录。
#[derive(Debug)]
pub enum Miss {
    Empty,
    Services(String),
    Stalled,
    /// 再试也没用：没登录、进程退出。
    Fatal(AgentError),
}

impl From<AgentError> for Miss {
    fn from(err: AgentError) -> Self {
        Self::Fatal(err)
    }
}

impl Miss {
    fn into_error(self) -> AgentError {
        let reason = match self {
            Self::Fatal(err) => return err,
            Self::Empty => "回复一直是空的".to_string(),
            Self::Services(message) => message,
            Self::Stalled => "cursor/list_available_models 一直没有回应".to_string(),
        };
        AgentError::Runtime(format!("Cursor Agent 取不到模型目录：{reason}。请检查网络或代理后再试。"))
    }
}

/// 在同一进程里取，回空或服务不可用时等一下再取。
pub async fn refetch<T, F, Fut>(mut fetch: F) -> Result<T, Miss>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, Miss>>,
{
    let mut waited = 0;
    loop {
        match fetch().await {
            Err(Miss::Empty | Miss::Services(_)) if waited < REFETCHES => {
                waited += 1;
                tokio::time::sleep(REFETCH_WAIT * waited).await;
            }
            outcome => return outcome,
        }
    }
}

/// 每次调用 `launch` 起一个新进程，失败的进程由它自己关掉。
pub async fn with_restarts<T, F, Fut>(mut launch: F) -> Result<T, AgentError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, Miss>>,
{
    let mut started = 0;
    loop {
        started += 1;
        match launch().await {
            Ok(value) => return Ok(value),
            Err(miss @ Miss::Fatal(_)) => return Err(miss.into_error()),
            Err(miss) if started == PROCESSES => return Err(miss.into_error()),
            Err(_) => tokio::time::sleep(RESTART_WAIT).await,
        }
    }
}
