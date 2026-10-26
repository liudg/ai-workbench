import { useAgentProfiles } from "@/features/agents";
import { tasksApi } from "@/features/tasks";
import type { WorktreeDeleteFlags } from "@/lib/worktree-delete";
import { agentIdentity } from "@/shared/agent/identity";
import { showError } from "@/shared/shell/error-banner";
import { leaveTask, openTask } from "@/shared/shell/navigation";
import { isFinishedStatus } from "@/shared/unread-finished";
import type { SidebarTask } from "../sidebar-task";
import { showSidebarNotice } from "../sidebar-notice";
import { useUnreadFinished } from "../unread";

export function useSessionRow(task: SidebarTask) {
  const profiles = useAgentProfiles();
  const unread = useUnreadFinished(task.id);
  return {
    identity: task.agent ? agentIdentity(task.agent, profiles[task.agent]) : null,
    unreadFinished: unread && isFinishedStatus(task.status),
    select: () => openTask(task.id, task.projectId),
    rename: (title: string) => tasksApi.renameTask(task.id, title).then(() => true, () => false),
    togglePinned: () => void tasksApi.setTaskPinned(task.id, !task.pinned).catch(showError),
    toggleArchived: () => {
      if (!task.archived) leaveTask(task.id);
      void tasksApi.archiveTask(task.id, !task.archived).catch(showError);
    },
    /** 读不到时当作没有工作台的工作树，删除时不动目录。 */
    loadDeletePreview: () => tasksApi.deletePreview(task.id).catch(() => null),
    remove: (options: WorktreeDeleteFlags) =>
      tasksApi.removeTask(task.id, options).then(
        () => {
          leaveTask(task.id);
          showSidebarNotice("任务已删除");
          return true;
        },
        () => false,
      ),
  };
}
