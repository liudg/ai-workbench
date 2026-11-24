// 侧栏里的一行会话。一个任务一行，状态和 Agent 取任务现在用的会话。

import { currentSession } from "../tasks/current-session.ts";
import type { TaskEntry } from "../tasks/index.ts";
import type { Attention } from "../../shared/attention/index.ts";
import type { AgentKind, SessionStatus } from "../../types/index.ts";

export const UNTITLED_SESSION = "新会话";

export interface SidebarTask {
  id: string;
  projectId: string | null;
  agent: AgentKind | undefined;
  instanceId?: string;
  /** 现在这段的原生会话。有它才能原生分叉。 */
  nativeId?: string;
  title: string;
  status: SessionStatus | undefined;
  attention: Attention;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  /** 开出这个子任务的任务。 */
  parentTaskId: string | null;
}

export function sidebarTask(task: TaskEntry): SidebarTask {
  const session = currentSession(task);
  return {
    id: task.id,
    projectId: task.projectId ?? null,
    agent: session?.agent,
    ...(session?.instanceId ? { instanceId: session.instanceId } : {}),
    nativeId: session?.nativeId,
    title: task.title.trim() || UNTITLED_SESSION,
    status: session?.status,
    attention: task.attention,
    updatedAt: task.updatedAt,
    pinned: task.pinned,
    archived: Boolean(task.archivedAt),
    parentTaskId: task.parentTaskId ?? null,
  };
}
