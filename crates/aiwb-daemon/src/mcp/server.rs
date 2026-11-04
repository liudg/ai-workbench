//! MCP 服务端：把各组工具合在一起。新的一组工具加一个文件，在 [`WorkbenchServer::new`] 里加上它的路由。

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{tool_handler, ServerHandler};

use crate::services::Services;

/// 重试幂等的结果留多久（照 t3code `clientRequestId`）。
const REPLAY_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub(crate) struct WorkbenchServer {
    pub(super) services: Arc<Services>,
    /// 调用键 → （开始或做完的时间，做完的结果）。还在做时结果为空。
    replays: Arc<Mutex<HashMap<String, (Instant, Option<String>)>>>,
    tool_router: ToolRouter<Self>,
}

impl WorkbenchServer {
    pub(crate) fn new(services: Arc<Services>) -> Self {
        Self {
            services,
            replays: Arc::default(),
            tool_router: Self::subtask_tools(),
        }
    }

    /// 带 `clientRequestId` 的调用：同一调用方同一 id 在有效期内只做一次，重试直接给上次成功的结果；
    /// 上一次还没做完时重试被拒，不会并行再做一遍。失败的不记，可以重试。
    pub(super) async fn once<F>(&self, scope: &str, request_id: Option<&str>, work: F) -> Result<String, String>
    where
        F: Future<Output = Result<String, String>>,
    {
        let Some(request_id) = request_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return work.await;
        };
        let key = format!("{scope}\n{request_id}");
        {
            let mut replays = self.replays.lock().unwrap();
            replays.retain(|_, (at, _)| at.elapsed() < REPLAY_TTL);
            match replays.get(&key) {
                Some((_, Some(reply))) => return Ok(reply.clone()),
                Some((_, None)) => {
                    return Err("in_progress: 同一个 clientRequestId 的上一次调用还没做完，稍后用它再试".into())
                }
                None => {
                    replays.insert(key.clone(), (Instant::now(), None));
                }
            }
        }
        // 请求中途断开时这个 future 会被丢掉，靠守卫把「还在做」清掉。
        let guard = InFlight {
            replays: &self.replays,
            key,
        };
        let reply = work.await?;
        guard
            .replays
            .lock()
            .unwrap()
            .insert(guard.key.clone(), (Instant::now(), Some(reply.clone())));
        Ok(reply)
    }
}

/// 没做完就结束（失败或被丢掉）时移除「还在做」的记录。
struct InFlight<'a> {
    replays: &'a Mutex<HashMap<String, (Instant, Option<String>)>>,
    key: String,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut replays = self.replays.lock().unwrap_or_else(|p| p.into_inner());
        if replays.get(&self.key).is_some_and(|(_, reply)| reply.is_none()) {
            replays.remove(&self.key);
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for WorkbenchServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("aiwb", crate::VERSION))
            .with_instructions(
                "AI Workbench tools. They act only on the calling session's own task: \
                 split work into subtasks that run as separate workbench tasks, check on them, and steer them.",
            )
    }
}
