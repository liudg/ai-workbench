import { useMemo } from "react";

import type { SubtaskHost, SubtaskView } from "@/features/chat/host";
import { currentSession, tasksApi, useTasks } from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import { openTask } from "@/shared/shell/navigation";
import { openSubtaskBeside } from "../subtask-panel/open";

/**
 * 时间线里子任务的标题、状态、跳转和开子任务卡片的选择。
 * 任务列表每次状态变化都会推一份新的，宿主只在标题或归属变了时才换，免得整条时间线跟着重画；
 * 每行自己用 `useSubtask` 跟着任务列表变。
 */
export function useSubtaskHost(sessionId: string): SubtaskHost {
  const { tasks } = useTasks();
  const key = tasks.map((task) => `${task.id}\u0000${task.title}\u0000${task.projectId ?? ""}`).join("\n");
  return useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return {
      title: (taskId) => byId.get(taskId)?.title.trim() || undefined,
      useSubtask,
      open: (taskId) => {
        const task = byId.get(taskId);
        if (task) openTask(task.id, task.projectId ?? null);
      },
      openBeside: (taskId) => openSubtaskBeside(sessionId, taskId),
      resolveOffer: (sessionId, offerId, accept) =>
        tasksApi.resolveOffer(sessionId, offerId, accept).then(() => undefined, showError),
    };
    // 只看 key 里的字段；tasks 本身每次都是新数组。
  }, [key, sessionId]);
}

/** 一个子任务现在的样子。只有它自己的字段变了才换新对象。 */
function useSubtask(taskId: string): SubtaskView | undefined {
  const { tasks } = useTasks();
  const task = tasks.find((item) => item.id === taskId && !item.archivedAt);
  const session = task ? currentSession(task) : undefined;
  const attention = task?.attention;
  return useMemo(
    () =>
      task && session && attention
        ? { title: task.title, agent: session.agent, attention, since: session.updatedAt }
        : undefined,
    // 任务列表每次都是新对象，按字段比。
    [
      task?.title,
      session?.agent,
      session?.updatedAt,
      attention?.state,
      attention?.ask,
      attention?.preview,
      attention?.unread,
      attention?.updatedAt,
    ],
  );
}
