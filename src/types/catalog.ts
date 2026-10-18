// 与 `src-tauri/src/models/catalog.rs` 对应。能力开关不比较 Agent 种类。

import type { AgentKind } from "./agent.ts";
import type { SessionEvent } from "./event.ts";

/** 作曲栏权限档位。适配器自行映射到各自的沙箱 / 审批。文案只来自权限菜单。 */
export type AccessMode = "full" | "ask" | "read-only" | "approve-for-me";

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
  /** 适配器说明。权限菜单不渲染。 */
  description: string;
  /** 有值时不可选，值是原因。 */
  disabled_reason?: string | null;
  /** 选中时按钮用警示色。适配器标，界面不按 id 猜。 */
  caution?: boolean;
  /** 选中这一档时可以显示网络开关和额外目录。 */
  allows_extras?: boolean;
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
  /** 这一会话当前档位。界面不另猜。 */
  active?: string | null;
}

export interface Attachment {
  name: string;
  path: string;
}

export interface ReasoningEffortOption {
  id: string;
  /** 适配器说明。菜单和芯片不渲染，避免把英文实现说明截成半句。 */
  description: string;
  /** 适配器短名。已知档位 id 的界面标签不看这个字段。 */
  label?: string | null;
}

/** `model/list` 的 `serviceTiers`。速度开关只认目录里真正有的档。 */
export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
  /** 适配器从 CLI 标成快速档。没有这个标记就不显示闪电。 */
  fast?: boolean;
}

export interface AgentModelOption {
  id: string;
  label: string;
  description: string;
  is_default: boolean;
  default_effort: string;
  efforts: ReasoningEffortOption[];
  /** 缺省表示出现在选择器里。`false` 对应 Codex `show_in_picker == false`。 */
  show_in_picker?: boolean;
  service_tiers?: ModelServiceTier[];
  default_service_tier?: string | null;
  /** CLI `resolvedModel`。自定义映射后的真实名，选模时可对齐 thread_model。 */
  resolved_model?: string | null;
}

/** 作曲栏这次会话改过的模型、推理强度和速度档。 */
export interface SessionTuning {
  model: string;
  effort: string;
  /** `null` 表示用户关掉速度档。缺省表示还没改，沿用 CLI 配置。 */
  serviceTier?: string | null;
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
  /** `thread/archive` 与 `thread/unarchive`。没有这对接口时为 false。 */
  supports_archive?: boolean;
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
  /** 账号订阅窗口。界面只在适配器声明这项时读取，不按 agent 名字分支。 */
  supports_subscription_usage?: boolean;
  /** 新建会话可以在一个新的 Git 工作树里运行。 */
  supports_worktree?: boolean;
}

/** 一个订阅用量窗口。已用和剩余至少有一个，重置时间可以没有。 */
export interface SubscriptionWindow {
  id: string;
  label: string;
  /** 已用百分比，0–100。 */
  used_percent?: number | null;
  /** 剩余百分比，0–100。 */
  remaining_percent?: number | null;
  /** 重置时刻，Unix 毫秒。 */
  resets_at_ms?: number | null;
}

export interface SubscriptionUsage {
  windows: SubscriptionWindow[];
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
  /** 新建会话的权限档。空表示不要拿另一个 Agent 的上次选择来填。 */
  default_access?: string | null;
  /** 适配器显示名。没有这条资料时侧栏不编名字。 */
  display_name?: string | null;
  /** 适配器图标资源。没有资源时侧栏用中性图标。 */
  icon?: string | null;
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
  /** CLI `config/read` 的 `service_tier`。`default` 不算覆盖。 */
  configured_service_tier?: string | null;
  /** 已经打开的线程自己的模型。新会话还没有。 */
  thread_model?: string | null;
  thread_effort?: string | null;
  /** `false` 表示 `config/read` 失败，不能把目录 isDefault 当成用户的 CLI 默认。 */
  cli_config_read?: boolean | null;
  /** 适配器在目录上标的 Agent。会话管理用来避免把另一边的目录写进缓存。界面不拿它挑模型。 */
  agent?: AgentKind | null;
}

/** `agent_catalog` 的返回。notice 有值时 catalog 仍是上次成功的目录。 */
export interface AgentCatalogRefresh {
  catalog: AgentCatalog;
  notice?: string | null;
}
