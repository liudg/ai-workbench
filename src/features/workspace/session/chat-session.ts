import type { TaskEntry, TaskSession } from "@/features/tasks";
import type { Session } from "@/types";

export const UNTITLED = "新会话";

/** 聊天视图认的会话形状。工作树和独立聊天的工作目录是它们自己的目录。 */
export function chatSession(task: TaskEntry, session: TaskSession): Session {
  const worktree = task.workspace.kind === "worktree" ? task.workspace : null;
  const folder = task.workspace.kind === "folder" ? task.workspace.path : null;
  return {
    id: session.id,
    project_id: task.projectId ?? "",
    agent: session.agent,
    native_id: session.nativeId ?? "",
    title: task.title.trim() || UNTITLED,
    status: session.status,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    workdir: worktree?.path ?? folder,
    worktree_branch: worktree?.branch ?? null,
    worktree_base: worktree?.baseRef ?? null,
    worktree_sha: worktree?.baseSha ?? null,
    worktree_owned: Boolean(worktree),
  };
}
