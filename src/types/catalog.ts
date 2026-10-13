// 与 `src-tauri/src/models/catalog.rs` 对应。能力开关不比较 Agent 种类。

import type { AgentKind } from "./agent.ts";
import type { SessionEvent } from "./event.ts";

/** 作曲栏权限档位。适配器自行映射到各自的沙箱 / 审批。 */
export type AccessMode = "full" | "ask" | "read-only" | "approve-for-me";

export const ACCESS_LABELS: Record<AccessMode, string> = {
  full: "完全访问",
  ask: "询问批准",
  "read-only": "只读",
  "approve-for-me": "替我批准",
};

/** 一次权限选择：档位、网络、额外可写目录、具名配置档。 */
export interface SessionSandbox {
  mode: AccessMode;
  networkAccess: boolean;
  writableRoots: string[];
  profileId: string;
}

export function emptySandbox(mode: AccessMode = "full"): SessionSandbox {
  return {
    mode,
    networkAccess: false,
    writableRoots: [],
    profileId: "",
  };
}

export interface PermissionProfileOption {
  id: string;
  label: string;
  description: string;
  /** 有值时不可选，值是原因。 */
  disabled_reason?: string | null;
}

/** 适配器给出的权限菜单：标题、内置档位、具名配置档和读取失败的说明。 */
export interface PermissionMenu {
  network_access: boolean;
  writable_roots: boolean;
  permission_profiles: boolean;
  approve_for_me: boolean;
  title: string;
  notice: string | null;
  presets: PermissionProfileOption[];
  profiles: PermissionProfileOption[];
}

export interface Attachment {
  name: string;
  path: string;
}

export interface ReasoningEffortOption {
  id: string;
  description: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
  description: string;
  is_default: boolean;
  default_effort: string;
  efforts: ReasoningEffortOption[];
}

export interface AgentSkillOption {
  name: string;
  mention: string;
  label: string;
  description: string;
  path: string;
}

/** 变更从哪来：回合 diff、逐文件补丁、git 范围。 */
export interface ChangeCapabilities {
  /** 回合统一 diff（`turn-diff`）。 */
  turn_diff: boolean;
  /** 逐文件补丁（`file-change` / `turn-changes`）。 */
  per_file_patch: boolean;
  /** 未提交 / 未暂存 / 已暂存。 */
  git_scopes: boolean;
}

/** 适配器能力。作曲栏和斜杠菜单看这些开关，不比较 agent 字符串。 */
export interface AgentCapabilities {
  supports_slash: boolean;
  supports_resume: boolean;
  supports_questions: boolean;
  supports_tuning: boolean;
  supports_skills: boolean;
  supports_goals?: boolean;
  /** 图片作为回合输入，作曲栏和气泡显示缩略图。 */
  supports_images?: boolean;
  /** 回合进行中仍可发送，消息进入排队。 */
  supports_queue?: boolean;
  supports_fork?: boolean;
  supports_delete?: boolean;
  supports_rename?: boolean;
  supports_plan?: boolean;
  changes: ChangeCapabilities;
  supports_review?: boolean;
  /** 询问批准 / 只读 / workspace-write 的网络开关。 */
  supports_network_access?: boolean;
  /** 额外可写目录，对应 Codex `--add-dir`。 */
  supports_writable_roots?: boolean;
  /** 具名权限配置档。会话探测后才为 true。 */
  supports_permission_profiles?: boolean;
  /** 替我批准（approvals reviewer auto_review）。 */
  supports_approve_for_me?: boolean;
  /** 继续会话后，时间线上滚再要更早的回合。 */
  supports_paged_history?: boolean;
}

/** 上滚加载更早回合之后的整段事件日志。 */
export interface OlderHistory {
  events: SessionEvent[];
  added: number;
  exhausted: boolean;
}

export interface QueuedTurn {
  id: string;
  text: string;
  images?: string[];
  client_id?: string;
}

export interface SlashCommand {
  name: string;
  hint: string;
  takes_args?: boolean;
}

/** 不打开会话也能拿到的能力说明和斜杠命令。 */
export interface AgentProfile {
  kind: AgentKind;
  capabilities: AgentCapabilities;
  commands: SlashCommand[];
}

export interface AgentCatalog {
  models: AgentModelOption[];
  skills: AgentSkillOption[];
  commands: SlashCommand[];
  capabilities: AgentCapabilities;
  /** `skills/list` 失败且没有可保留技能时的原因。成功的空列表没有这个字段。 */
  skills_error?: string | null;
  /** CLI `config/read` 的 `model`。空表示配置里没写，不是猜的。 */
  configured_model?: string | null;
  /** CLI `config/read` 的 `model_reasoning_effort`。 */
  configured_effort?: string | null;
  /** 已经打开的线程自己的模型。新会话还没有。 */
  thread_model?: string | null;
  thread_effort?: string | null;
  /** `false` 表示 `config/read` 失败，不能把目录 isDefault 当成用户的 CLI 默认。 */
  cli_config_read?: boolean | null;
}

/** `agent_catalog` 的返回。notice 有值时 catalog 仍是上次成功的目录。 */
export interface AgentCatalogRefresh {
  catalog: AgentCatalog;
  notice?: string | null;
}

/** 按 Agent 持久化的上次成功目录，启动时一次取回。 */
export interface CachedAgentCatalog {
  kind: AgentKind;
  catalog: AgentCatalog;
}

export const EFFORT_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

export function effortLabel(id: string | undefined): string {
  if (!id) return "默认";
  return EFFORT_LABELS[id] ?? id;
}
