import { backend } from "@/lib/ipc";

import type { WorktreeDeletePreview } from "./worktree-delete";

/** 读不到时当作没有工作台的工作树，删除任务时不动目录。 */
export async function loadWorktreeDeletePreview(
  sessionId: string,
): Promise<WorktreeDeletePreview | null> {
  try {
    return await backend.sessionWorktreeDeletePreview(sessionId);
  } catch {
    return null;
  }
}
