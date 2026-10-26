// 与 crates/aiwb-core/src/task.rs 一致。

import type { AgentKind, SessionStatus } from "@/types";

export type TaskWorkspace =
  | { kind: "root" }
  | { kind: "worktree"; path: string; branch: string; baseRef?: string; baseSha: string };

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
  projectId: string;
  title: string;
  workspace: TaskWorkspace;
  pinned: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
  sessions: TaskSession[];
}

export interface CreateTaskInput {
  projectId: string;
  prompt: string;
  images: string[];
  worktree: boolean;
  options: SessionOptions;
}
