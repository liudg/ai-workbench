// 与 `src-tauri/src/models/agent.rs` 对应。serde 用 kebab-case。

export type AgentKind =
  | "codex-cli"
  | "claude-code"
  | "cursor-agent"
  | "kimi-code"
  | "qwen-code"
  | "opencode"
  | "antigravity";

export const AGENT_LABELS: Record<AgentKind, string> = {
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
  "cursor-agent": "Cursor Agent",
  "kimi-code": "Kimi Code",
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

/** 官方升级渠道。前端只展示，真正的命令留在适配器里。 */
export type UpdateVia = "npm" | "cli";

/** 官方升级命令的执行结果，独立于上一次安装检测。 */
export interface AgentUpgrade {
  kind: AgentKind;
  status: "running" | "succeeded" | "failed";
  output: string;
  exit_code: number | null;
  error: string | null;
}

/** 本机一次探测。设置页用完整列表；新建会话只取 installed。 */
export interface AgentInstallation {
  kind: AgentKind;
  display_name: string;
  installed: boolean;
  version: string | null;
  latest_version: string | null;
  update_available: boolean;
  update_via: UpdateVia | null;
  detail: string | null;
  /** 会话协议已接入。未接入时设置页只显示「未安装」或「未接入」。 */
  session_linked: boolean;
}
