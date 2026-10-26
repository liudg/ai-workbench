// 与 crates/aiwb-core/src/task.rs 一致。

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
  pinned: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
  sessions: TaskSession[];
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

