// 与 src-tauri/src/models.rs 一一对应的 IPC 协议类型。
// serde 输出为 snake_case 字段 + kebab-case 枚举值，这里保持一致。

export type AgentKind = "codex-cli" | "claude-code";

export type SessionStatus =
  | "running"
  | "needs-input"
  | "completed"
  | "failed"
  | "stopped";

export type PromptKind = "approval" | "choice" | "free-text";

export interface Project {
  id: string;
  name: string;
  path: string;
  default_agent: AgentKind;
  created_at: number;
  updated_at: number;
  /** 由 Codex resume 挂上的目录，不在本地项目列表里。 */
  external?: boolean;
}

export interface Session {
  id: string;
  project_id: string;
  agent: AgentKind;
  title: string;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
}

export interface PromptOption {
  id: string;
  label: string;
}

/** 事件体（对应 Rust 的 SessionEventBody；适配器只产生这一层） */
export type SessionEventBody =
  | { kind: "user-message"; text: string }
  | { kind: "agent-message"; text: string; stream_id?: string }
  | { kind: "tool-call"; name: string; summary: string }
  | {
      kind: "prompt";
      prompt_id: string;
      prompt_kind: PromptKind;
      question: string;
      options: PromptOption[];
    }
  | { kind: "prompt-resolved"; prompt_id: string; answer: string }
  | { kind: "status-changed"; status: SessionStatus }
  | { kind: "system"; text: string }
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
};

/** 新建会话时可选的 Agent。后续模型接在这个列表上。 */
export const AGENT_OPTIONS: AgentKind[] = ["codex-cli", "claude-code"];

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

export interface AgentCatalog {
  models: AgentModelOption[];
  skills: AgentSkillOption[];
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
