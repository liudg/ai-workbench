import { useWorkbench } from "@/store";
import type { Project } from "@/types";

export function useProjectItem(project: Project) {
  const sessions = useWorkbench((s) => s.sessions[project.id]);
  const selected = useWorkbench((s) => s.selectedProjectId === project.id);
  const activeSessionId = useWorkbench((s) => s.activeSessionId[project.id]);
  const selectProject = useWorkbench((s) => s.selectProject);
  const removeProject = useWorkbench((s) => s.removeProject);
  return { sessions, selected, activeSessionId, selectProject, removeProject };
}
