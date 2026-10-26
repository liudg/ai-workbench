import { useProjects } from "@/features/projects";
import { currentSession, useTasks } from "@/features/tasks";
import { useNavigation } from "@/shared/shell/navigation";

/** 主区该看什么：设置、某个会话、某个项目的新会话，或者什么都没选。 */
export function useWorkspace() {
  const settings = useNavigation((state) => state.settings);
  const view = useNavigation((state) => state.view);
  const { projects, loading: projectsLoading } = useProjects();
  const { tasks, loading: tasksLoading } = useTasks();
  const task = view.kind === "task" ? tasks.find((item) => item.id === view.taskId) : undefined;
  const projectId = view.kind === "none" ? undefined : view.projectId;
  const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
  return {
    settings,
    view,
    projects,
    project,
    task,
    taskSession: task ? currentSession(task) : undefined,
    loading: projectsLoading || tasksLoading,
  };
}
