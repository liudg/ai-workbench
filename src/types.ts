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

export type PromptKind = "approval" | "choice" | "free-text" | "questions";

/** 问题卡片中的一道题（Codex 原生提问；一轮可有多题） */
export interface PromptQuestion {
  /** 阻塞式提问用 Codex 的 question id；async 提问按序合成 q1/q2… */
  id: string;
  /** 题目标签（Codex header），可空 */
  header?: string;
  question: string;
  /** 敏感回答，输入时掩码 */
  is_secret: boolean;
  /** 编号展示的选项；空数组 = 纯自由文本题 */
  options: PromptOption[];
}

/** 对提问的回答：审批/单选/单行文本走 single；问题卡片走 questions */
export type PromptAnswer =
  | { type: "single"; value: string }
  | { type: "questions"; answers: Record<string, string>; skipped: boolean };

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
}

export interface PromptOption {
  id: string;
  label: string;
  /** 选项说明（Codex requestUserInput 的 description），可空 */
  description?: string;
}

/** 事件体（对应 Rust 的 SessionEventBody；适配器只产生这一层） */
export type SessionEventBody =
  | { kind: "user-message"; text: string }
  | { kind: "agent-message"; text: string; stream_id?: string }
  | { kind: "thinking"; text: string; stream_id?: string }
  | { kind: "tool-call"; name: string; summary: string }
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
  | { kind: "error"; message: string };

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

/** 作曲栏权限档位。Codex 会话会映射到 sandbox / approval。 */
export type AccessMode = "full" | "ask" | "read-only";

export const ACCESS_LABELS: Record<AccessMode, string> = {
  full: "完全访问",
  ask: "询问批准",
  "read-only": "只读",
};

export const ACCESS_OPTIONS: AccessMode[] = ["full", "ask", "read-only"];

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

/** 适配器能力。作曲栏和斜杠菜单看这些开关，不比较 agent 字符串。 */
export interface AgentCapabilities {
  supports_slash: boolean;
  supports_resume: boolean;
  supports_questions: boolean;
  supports_tuning: boolean;
  supports_skills: boolean;
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

export const EMPTY_CAPABILITIES: AgentCapabilities = {
  supports_slash: false,
  supports_resume: false,
  supports_questions: false,
  supports_tuning: false,
  supports_skills: false,
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

export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: "运行中",
  "needs-input": "待处理",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

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
