//! 会话凭证。每次拉起 Agent 进程时发一个，内存里只存哈希；进程停掉就撤销，daemon 重启后全部作废。
//! 照 t3code `apps/server/src/mcp/McpSessionRegistry.ts` 的 `issue` / `resolve` / `revokeThread`。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use aiwb_agents::WorkbenchMcp;
use sha2::{Digest, Sha256};

type Digest32 = [u8; 32];

#[derive(Default)]
pub(crate) struct Credentials {
    /// `/mcp` 的地址。daemon 拿到端口后设上；没设时不发凭证。
    url: OnceLock<String>,
    /// 凭证哈希 → 会话 id。
    sessions: Mutex<HashMap<Digest32, String>>,
}

impl Credentials {
    pub(crate) fn set_url(&self, url: String) {
        let _ = self.url.set(url);
    }

    /// 给会话发一个新凭证，旧的作废。
    pub(crate) fn issue(&self, session_id: &str) -> Option<WorkbenchMcp> {
        let url = self.url.get()?.clone();
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, owner| owner != session_id);
        sessions.insert(digest(&token), session_id.to_string());
        Some(WorkbenchMcp { url, token, child: false })
    }

    pub(crate) fn resolve(&self, token: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(&digest(token)).cloned()
    }

    pub(crate) fn revoke(&self, session_id: &str) {
        self.sessions.lock().unwrap().retain(|_, owner| owner != session_id);
    }
}

fn digest(token: &str) -> Digest32 {
    Sha256::digest(token.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_resolve_and_revoke() {
        let credentials = Credentials::default();
        assert!(credentials.issue("s").is_none(), "没有地址时不发");
        credentials.set_url("http://127.0.0.1:1/mcp".into());
        let first = credentials.issue("s").unwrap();
        assert_eq!(first.url, "http://127.0.0.1:1/mcp");
        assert_eq!(credentials.resolve(&first.token).as_deref(), Some("s"));
        assert_eq!(credentials.resolve("guess"), None);

        // 重新拉起进程：旧凭证作废。
        let second = credentials.issue("s").unwrap();
        assert_eq!(credentials.resolve(&first.token), None);
        let other = credentials.issue("o").unwrap();
        credentials.revoke("s");
        assert_eq!(credentials.resolve(&second.token), None);
        assert_eq!(credentials.resolve(&other.token).as_deref(), Some("o"));
    }
}
