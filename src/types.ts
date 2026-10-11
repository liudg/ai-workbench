// 与 src-tauri/src/models.rs 一一对应的 IPC 协议类型。
// serde 输出为 snake_case 字段 + kebab-case 枚举值，这里保持一致。

export type AgentKind =
  | "codex-cli"
  | "claude-code"
  | "cursor-agent"
  | "copilot-cli"
  | "kimi-code"
  | "qwen-code"
  | "opencode"
  | "goose"
  | "antigravity"
  | "kiro-cli";

export type SessionStatus =
  | "running"
  | "needs-input"
  | "completed"
  | "failed"
  | "stopped";

export type PromptKind = "approval" | "choice" | "free-text" | "questions" | "elicitation";

/**
 * 适配器标出的助手文本阶段。时间线只看这个字段，不比较 agent 种类。
 * 缺省表示协议没给阶段。
 */
export type MessagePhase = "commentary" | "partial-answer" | "final-answer";

/** 问题卡片中的一道题。适配器把原生提问映射进来；一轮可有多题。 */
export interface PromptQuestion {
  /** 阻塞式提问用上游 question id；async 提问按序合成 q1/q2… */
  id: string;
  /** 题目标签，可空 */
  header?: string;
  question: string;
  /** 敏感回答，输入时掩码 */
  is_secret: boolean;
  /** 编号展示的选项；空数组 = 纯自由文本题。elicitation 的 enum 也放这里。 */
  options: PromptOption[];
  /** elicitation 字段类型：string / number / integer / boolean。 */
  input_kind?: string;
  /** elicitation 的 required。 */
  required?: boolean;
}

/** 对提问的回答：审批/单选/单行文本走 single；问题卡片走 questions */
export type PromptAnswer =
  | { type: "single"; value: string }
  | { type: "questions"; answers: Record<string, string>; skipped: boolean }
  | {
      type: "elicitation";
      action: "accept" | "decline" | "cancel";
      content?: Record<string, string | number | boolean>;
    };

export interface Project {
  id: string;
  name: string;
  path: string;
  default_agent: AgentKind;
  created_at: number;
  updated_at: number;
  /** 保留字段。侧边栏不再挂上来自 Agent 目录、尚未导入的项目。 */
  external?: boolean;
}

export interface Session {
  id: string;
  project_id: string;
  agent: AgentKind;
  /** Agent 自己的会话 id。`id` 是 `{agent}:{native_id}`。 */
  native_id: string;
  title: string;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  /** 已归档的聊天不进默认侧边栏。 */
  archived?: boolean;
}

export interface PromptOption {
  id: string;
  label: string;
  /** 选项说明，可空 */
  description?: string;
}

/** 事件体（对应 Rust 的 SessionEventBody；适配器只产生这一层） */
export type SessionEventBody =
  | { kind: "user-message"; text: string; images?: string[] }
  | {
      kind: "agent-message";
      text: string;
      stream_id?: string;
      /** 过程旁白 / 部分答复 / 最终答复。缺省表示阶段未知。 */
      phase?: MessagePhase;
    }
  | { kind: "thinking"; text: string; stream_id?: string }
  | {
      kind: "tool-call";
      name: string;
      summary: string;
      /** 命令输出、补丁正文、MCP 参数和结果。时间线默认折叠。 */
      detail?: string;
      stream_id?: string;
      images?: string[];
    }
  | {
      kind: "prompt";
      prompt_id: string;
      prompt_kind: PromptKind;
      question: string;
      options: PromptOption[];
      /** prompt_kind === "questions" 时的逐题内容；其它类型为空 */
      questions: PromptQuestion[];
    }
  | { kind: "prompt-resolved"; prompt_id: string; answer: string }
  | { kind: "status-changed"; status: SessionStatus }
  | { kind: "system"; text: string }
  /** 线程被其他进程占用。历史已打开，输入框不可发送。 */
  | { kind: "read-only"; text: string }
  | { kind: "error"; message: string }
  | { kind: "turn-anchor"; turn_id: string }
  | { kind: "turn-diff"; turn_id: string; diff: string }
  | {
      kind: "plan-steps";
      turn_id: string;
      explanation?: string;
      steps: PlanStep[];
    }
  | { kind: "plan-text"; text: string; stream_id?: string }
  | { kind: "review-note"; text: string }
  | {
      kind: "review-findings";
      summary: string;
      findings: ReviewFinding[];
      raw: string;
    }
  | { kind: "collaboration-mode"; mode: string };

export interface PlanStep {
  step: string;
  status: string;
}

export interface ReviewFinding {
  title: string;
  location: string;
  body: string;
}

export type ReviewStart =
  | { kind: "uncommitted" }
  | { kind: "base"; branch: string }
  | { kind: "commit"; sha: string; title?: string };

export interface ReviewCommit {
  sha: string;
  title: string;
}

export interface ReviewTargets {
  branches: string[];
  commits: ReviewCommit[];
  error?: string | null;
}

/** 完整事件 = 事件体 + 信封（id / seq / ts 由 SessionManager 统一赋值） */
export type SessionEvent = {
  id: string;
  session_id: string;
  seq: number;
  ts: number;
} & SessionEventBody;

export const AGENT_LABELS: Record<AgentKind, string> = {
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
  "cursor-agent": "Cursor Agent",
  "copilot-cli": "GitHub Copilot CLI",
  "kimi-code": "Kimi Code",
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
  goose: "Goose",
  antigravity: "Antigravity",
  "kiro-cli": "Kiro CLI",
};

/** 官方升级渠道。前端只展示，真正的命令留在适配器里。 */
export type UpdateVia = "npm" | "cli";

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
}

/** 作曲栏权限档位。适配器自行映射到各自的沙箱 / 审批。 */
export type AccessMode = "full" | "ask" | "read-only" | "approve-for-me";

export const ACCESS_LABELS: Record<AccessMode, string> = {
  full: "完全访问",
  ask: "询问批准",
  "read-only": "只读",
  "approve-for-me": "替我批准",
};

/** 没有沙箱扩展能力时的三项。Codex 桌面菜单另见 access.ts。 */
export const ACCESS_OPTIONS: AccessMode[] = ["full", "ask", "read-only"];

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
}

/** app-server 探测结果。键不存在时对应开关为 false。 */
export interface PermissionMenu {
  network_access: boolean;
  writable_roots: boolean;
  permission_profiles: boolean;
  approve_for_me: boolean;
  profiles: PermissionProfileOption[];
}

export interface Attachment {
  name: string;
  path: string;
}

/** 内置浏览器批注。发送时由适配层折进回合，不绑某个 Agent。 */
export interface PageAnnotation {
  id: string;
  url: string;
  selector: string;
  text: string;
  comment: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: string;
  screenshot?: string;
  snapshotFailed?: boolean;
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
  supports_archive?: boolean;
  supports_delete?: boolean;
  supports_rename?: boolean;
  supports_plan?: boolean;
  supports_turn_diff?: boolean;
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

export const EMPTY_CAPABILITIES: AgentCapabilities = {
  supports_slash: false,
  supports_resume: false,
  supports_questions: false,
  supports_tuning: false,
  supports_skills: false,
  supports_goals: false,
  supports_images: false,
  supports_queue: false,
  supports_fork: false,
  supports_archive: false,
  supports_delete: false,
  supports_rename: false,
  supports_plan: false,
  supports_turn_diff: false,
  supports_review: false,
};

export function emptyCatalog(): AgentCatalog {
  return {
    models: [],
    skills: [],
    commands: [],
    capabilities: { ...EMPTY_CAPABILITIES },
  };
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

/** 项目聚合状态：需要处理 > 运行中 > 失败 > 已完成 > 已停止 */
export function aggregateStatus(sessions: Session[]): SessionStatus | null {
  if (sessions.length === 0) return null;
  const rank: Record<SessionStatus, number> = {
    "needs-input": 5,
    running: 4,
    failed: 3,
    completed: 2,
    stopped: 1,
  };
  return sessions.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a))
    .status;
}
