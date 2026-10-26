// 侧栏里的一行会话。一个任务一行，状态和 Agent 取任务现在用的会话。

import { currentSession, type TaskEntry } from "@/features/tasks";
import type { AgentKind, SessionStatus } from "@/types";

export const UNTITLED_SESSION = "新会话";

export interface SidebarTask {
  id: string;
  projectId: string | null;
  agent: AgentKind | undefined;
  title: string;
  status: SessionStatus | undefined;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
}

export function sidebarTask(task: TaskEntry): SidebarTask {
  const session = currentSession(task);
  return {
    id: task.id,
    projectId: task.projectId ?? null,
    agent: session?.agent,
    title: task.title.trim() || UNTITLED_SESSION,
    status: session?.status,
    updatedAt: task.updatedAt,
    pinned: task.pinned,
    archived: Boolean(task.archivedAt),
  };
}

const STATUS_RANK: Record<SessionStatus, number> = {
  "needs-input": 5,
  running: 4,
  failed: 3,
  completed: 2,
  stopped: 1,
};

/** 项目行上的聚合状态：需要处理 > 运行中 > 失败 > 已完成 > 已停止。 */
export function aggregateStatus(tasks: readonly SidebarTask[]): SessionStatus | null {
  let best: SessionStatus | null = null;
  for (const task of tasks) {
    if (!task.status) continue;
    if (!best || STATUS_RANK[task.status] > STATUS_RANK[best]) best = task.status;
  }
  return best;
}
