//! 工作台 MCP 写进线程 `config`。键用点号路径 `mcp_servers.aiwb`，只覆盖这一项，用户配的 MCP 不受影响。
//! 照 t3code `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` 的 `codexThreadRuntimeParams`。

use serde_json::{json, Value};

use crate::WorkbenchMcp;

pub(super) fn attach(params: &mut Value, mcp: Option<&WorkbenchMcp>) {
    let Some(mcp) = mcp else {
        return;
    };
    let Some(params) = params.as_object_mut() else {
        return;
    };
    let config = params.entry("config").or_insert_with(|| json!({}));
    if let Some(config) = config.as_object_mut() {
        config.insert(
            format!("mcp_servers.{}", WorkbenchMcp::SERVER_NAME),
            json!({
                "url": mcp.url,
                "http_headers": { "Authorization": mcp.authorization() },
            }),
        );
    }
}

/// 什么时候用工作台的工具，放进每个回合的 `turn/start.additionalContext`（应用给的上下文，不进用户消息）。
/// 只靠工具描述时，用户说「开个嵌套会话」Codex 会用自带的 `spawn_agent`（2026-11-05 实测）。
/// 照 t3code `apps/server/src/provider/CodexDeveloperInstructions.ts` 的 `buildCodexAdditionalContext`；
/// codex-cli 0.165.0 实测模型能读到。
pub(super) fn attach_instructions(params: &mut Value, mcp: Option<&WorkbenchMcp>) {
    if mcp.is_none() {
        return;
    }
    params["additionalContext"] = json!({
        "aiwb_subtasks": { "kind": "application", "value": WorkbenchMcp::INSTRUCTIONS },
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_sandbox_config_and_adds_only_its_own_server() {
        let mut params = json!({ "config": { "sandbox_workspace_write": { "network_access": true } } });
        let mcp = WorkbenchMcp {
            url: "http://127.0.0.1:9/mcp".into(),
            token: "t".into(),
        };
        attach(&mut params, Some(&mcp));
        assert_eq!(params["config"]["sandbox_workspace_write"]["network_access"], true);
        let server = &params["config"]["mcp_servers.aiwb"];
        assert_eq!(server["url"], "http://127.0.0.1:9/mcp");
        assert_eq!(server["http_headers"]["Authorization"], "Bearer t");

        let mut bare = json!({ "threadId": "x" });
        attach(&mut bare, None);
        assert!(bare.get("config").is_none());
    }

    #[test]
    fn turns_carry_the_instructions_only_with_the_workbench_mcp() {
        let mcp = WorkbenchMcp {
            url: "http://127.0.0.1:9/mcp".into(),
            token: "t".into(),
        };
        let mut params = json!({ "threadId": "x" });
        attach_instructions(&mut params, Some(&mcp));
        assert_eq!(params["additionalContext"]["aiwb_subtasks"]["kind"], "application");
        assert!(params["additionalContext"]["aiwb_subtasks"]["value"]
            .as_str()
            .unwrap()
            .contains("aiwb_subtask_create"));
        let mut bare = json!({ "threadId": "x" });
        attach_instructions(&mut bare, None);
        assert!(bare.get("additionalContext").is_none());
    }
}
