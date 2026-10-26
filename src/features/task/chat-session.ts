import type { TaskEntry, TaskSession } from "@/features/tasks";
import type { Session } from "@/types";

/** 聊天视图认的会话形状。工作树任务的工作目录是检出目录。 */
export function chatSession(task: TaskEntry, session: TaskSession): Session {
  const worktree = task.workspace.kind === "worktree" ? task.workspace : null;
  return {
    id: session.id,
    project_id: task.projectId,
    agent: session.agent,
    native_id: session.nativeId ?? "",
    title: task.title,
    status: session.status,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    workdir: worktree?.path ?? null,
    worktree_branch: worktree?.branch ?? null,
    worktree_base: worktree?.baseRef ?? null,
    worktree_sha: worktree?.baseSha ?? null,
    worktree_owned: Boolean(worktree),
  };
}
