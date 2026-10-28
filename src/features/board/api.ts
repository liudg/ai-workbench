// 看板和注意力的 daemon 调用。

import { daemon } from "@/lib/daemon";

/** 告诉 daemon 现在正看着哪个任务（空表示没在看）。看着的任务不记未读。 */
export function reportViewing(taskId: string | null) {
  return daemon.call<null>("attention.view", { taskId });
}
