import { useMemo } from "react";

import { useProjects } from "@/features/projects";
import { useTasks } from "@/features/tasks";
import { selectedProjectOf, useNavigation } from "@/shared/shell/navigation";
import { splitPinnedProjects } from "./projects/project-sections";
import { sidebarTask, type SidebarTask } from "./sidebar-task";
import { useSidebarNotice } from "./sidebar-notice";

const NO_TASKS: SidebarTask[] = [];

/** 侧栏的项目和会话。会话按项目分好，独立聊天单独一组。 */
export function useSidebar() {
  const { projects, loading } = useProjects();
  const { tasks } = useTasks();
  const view = useNavigation((state) => state.view);
  const visibleTaskId = view.kind === "task" ? view.taskId : null;

  const byProject = useMemo(() => {
    const groups = new Map<string | null, SidebarTask[]>();
    for (const task of tasks) {
      const row = sidebarTask(task);
      const list = groups.get(row.projectId);
      if (list) list.push(row);
      else groups.set(row.projectId, [row]);
    }
    return groups;
  }, [tasks]);
  const sections = useMemo(
    () => splitPinnedProjects(projects, projects.filter((project) => project.pinned).map((project) => project.id)),
    [projects],
  );
  return {
    pinned: sections.pinned,
    unpinned: sections.unpinned,
    loading,
    tasksOf: (projectId: string | null) => byProject.get(projectId) ?? NO_TASKS,
    selectedProjectId: selectedProjectOf(view),
    activeTaskId: visibleTaskId,
    notice: useSidebarNotice(),
  };
}
