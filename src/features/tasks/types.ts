// 与 crates/aiwb-core/src/task.rs 一致。

import type { Attention } from "@/shared/attention";
import type { AgentKind, SessionStatus } from "@/types";

export type TaskWorkspace =
  | { kind: "root" }
  | { kind: "worktree"; path: string; branch: string; baseRef?: string; baseSha: string }
  /** 独立聊天自己的文件夹。 */
  | { kind: "folder"; path: string };

export interface SessionAccess {
  mode: string;
  networkAccess: boolean;
  writableRoots: string[];
  profileId: string;
}

export interface SessionOptions {
  model?: string;
  effort?: string;
  serviceTier?: string;
  access?: SessionAccess;
  collaborationMode?: string;
  followUpQueueMode?: string;
}

export interface TaskSession {
  id: string;
  taskId: string;
  agent: AgentKind;
  nativeId?: string;
  status: SessionStatus;
  options: SessionOptions;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEntry {
  id: string;
  /** 独立聊天没有项目。 */
  projectId?: string;
  title: string;
  workspace: TaskWorkspace;
  /** 开出这个子任务的任务。 */
  parentTaskId?: string;
  pinned: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
  sessions: TaskSession[];
  /** 现在用的会话的注意力。 */
  attention: Attention;
  /** 开着的侧边聊天。不算任务的会话段。 */
  side?: TaskSession;
}

export interface CreateTaskInput {
  /** 空表示独立聊天。 */
  projectId: string | null;
  agent: AgentKind;
  prompt: string;
  images: string[];
  worktree: boolean;
  options: SessionOptions;
  /** 首发前先设好的目标。 */
  goal?: string;
  goalStatus?: "paused" | "active";
}


/** CLI 里开过、可以导入的一条会话。 */
export interface ImportCandidate {
  agent: AgentKind;
  nativeId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImportList {
  items: ImportCandidate[];
  /** 读不出列表的 Agent 和原因。其他 Agent 的照常列出。 */
  errors: { agent: AgentKind; message: string }[];
}

export interface ImportResult {
  taskIds: string[];
  failures: (ImportCandidate & { message: string })[];
}
