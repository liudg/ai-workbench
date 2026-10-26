import { projectsApi, type Project } from "@/features/projects";
import { revealFolder } from "@/lib/native/open-path";
import { showError } from "@/shared/shell/error-banner";
import { leaveProject, openProject } from "@/shared/shell/navigation";
import type { SidebarTask } from "../sidebar-task";

export function useProjectItem(project: Project, tasks: readonly SidebarTask[]) {
  return {
    selectProject: () => openProject(project.id, tasks.map((task) => task.id)),
    togglePinned: () => void projectsApi.setProjectPinned(project.id, !project.pinned).catch(showError),
    openFolder: () => void revealFolder(project.path).catch(showError),
    removeProject: () =>
      void projectsApi.removeProject(project.id).then(() => leaveProject(project.id), showError),
  };
}
