import { useMemo } from "react";

import type { SubtaskHost } from "@/features/chat/host";
import { tasksApi, useTasks } from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import { openTask } from "@/shared/shell/navigation";

/**
 * 时间线里子任务的标题、跳转和开子任务卡片的选择。
 * 任务列表每次状态变化都会推一份新的，宿主只在标题或归属变了时才换，免得整条时间线跟着重画。
 */
export function useSubtaskHost(): SubtaskHost {
  const { tasks } = useTasks();
  const key = tasks.map((task) => `${task.id}\u0000${task.title}\u0000${task.projectId ?? ""}`).join("\n");
  return useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return {
      title: (taskId) => byId.get(taskId)?.title.trim() || undefined,
      open: (taskId) => {
        const task = byId.get(taskId);
        if (task) openTask(task.id, task.projectId ?? null);
      },
      resolveOffer: (sessionId, offerId, accept) =>
        tasksApi.resolveOffer(sessionId, offerId, accept).then(() => undefined, showError),
    };
    // 只看 key 里的字段；tasks 本身每次都是新数组。
  }, [key]);
}
