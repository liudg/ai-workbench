// 与 `crates/aiwb-core/src/models/agent.rs` 对应。serde 用 kebab-case。

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

/** 一种 Agent 这次启动后探模型目录的结果。探成功才算就绪。 */
export interface CatalogProbe {
  kind: AgentKind;
  instance_id?: string | null;
  status: "probing" | "ready" | "failed";
  error: string | null;
}

/** 本机一次探测。设置页用完整列表；新建会话只取 installed。 */
export interface AgentInstallation {
  kind: AgentKind;
  instance_id?: string | null;
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

export const SECRET_REDACTED = "••••••••";

export function defaultInstanceId(kind: AgentKind): string {
  return kind;
}

export function effectiveInstanceId(kind: AgentKind, instanceId?: string | null): string {
  const trimmed = instanceId?.trim();
  return trimmed ? trimmed : kind;
}

export function nonDefaultInstanceId(
  kind: AgentKind,
  instanceId?: string | null,
): string | undefined {
  const effective = effectiveInstanceId(kind, instanceId);
  return effective !== defaultInstanceId(kind) ? effective : undefined;
}

export type IsolationMode = "hostDefault" | "isolatedHome" | "shadowHome";

export interface AgentEnvVar {
  name: string;
  value: string;
  sensitive: boolean;
  valueRedacted?: boolean;
}

export interface AgentInstance {
  id: string;
  kind: AgentKind;
  displayName: string;
  accentColor?: string | null;
  binaryPath?: string | null;
  launchArgs?: string[];
  environment?: AgentEnvVar[];
  isolationMode: IsolationMode;
  homePath?: string | null;
  sharedHomePath?: string | null;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export type TextGenMode = "auto" | "cli" | "http";
export type TextGenHttpProtocol = "openAi" | "anthropic";

export interface TextGenHttpConfig {
  protocol: TextGenHttpProtocol;
  baseUrl: string;
  apiKey: string;
  apiKeyRedacted?: boolean;
  model: string;
}

export interface TextGenSettings {
  mode: TextGenMode;
  instanceId?: string | null;
  model?: string | null;
  autoTitle: boolean;
  http?: TextGenHttpConfig | null;
}

export interface GeneratedCommitMessage {
  subject: string;
  body?: string;
  message: string;
}
