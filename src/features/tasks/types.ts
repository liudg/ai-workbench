// 与 crates/aiwb-core/src/task.rs 一致。

import type { Attention } from "@/shared/attention";
import type { AgentKind, SessionStatus } from "@/types";

export type TaskWorkspace =
  | { kind: "root" }
  | {
      kind: "worktree";
      path: string;
      /** 旧版的任务分支。新工作树是分离头指针，没有这个字段。 */
      branch?: string;
      baseRef?: string;
      baseSha: string;
      /** 工作树已被清理。下次用到时在原路径恢复。 */
      shelved?: WorktreeSnapshot;
      /** 交给了项目目录。会话在项目目录里干活。 */
      local?: LocalHandoff;
    }
  /** 独立聊天自己的文件夹。 */
  | { kind: "folder"; path: string };

export interface LocalHandoff {
  branch: string;
  previousBranch?: string;
  previousHead: string;
}

export interface WorktreeSnapshot {
  reference: string;
  head: string;
  branch?: string;
  root: string;
}

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
  /** 工作树任务现在的分支。 */
  branch?: string;
}

export interface CreateTaskInput {
  /** 空表示独立聊天。 */
  projectId: string | null;
  agent: AgentKind;
  prompt: string;
  images: string[];
  worktree: boolean;
  /** 工作树的起点分支。不给时用项目目录现在的提交。 */
  worktreeBase?: string;
  carryChanges?: boolean;
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

/** 一个 Agent 的一页，从新到旧。 */
export interface ImportPage {
  items: ImportCandidate[];
  /** 还有更早的会话时给，原样传回取下一页。 */
  nextCursor: string | null;
}

export interface ImportResult {
  taskIds: string[];
  failures: (ImportCandidate & { message: string })[];
}
