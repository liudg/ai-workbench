// 与 `src-tauri/src/models/session.rs` 对应。

import type { AgentKind } from "./agent.ts";

export type SessionStatus =
  | "running"
  | "needs-input"
  | "completed"
  | "failed"
  | "stopped";

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
  /** 已归档的聊天不进默认列表，收在「已归档」里。 */
  archived?: boolean;
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
