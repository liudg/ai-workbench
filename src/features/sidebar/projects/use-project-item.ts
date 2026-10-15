import { useWorkbench } from "@/store";
import type { Project } from "@/types";

export function useProjectItem(project: Project) {
  const sessions = useWorkbench((s) => s.sessions[project.id]);
  const selected = useWorkbench((s) => s.selectedProjectId === project.id);
  const activeSessionId = useWorkbench((s) => s.activeSessionId[project.id]);
  const draft = useWorkbench((s) => s.drafts[project.id]);
  const pendingStart = useWorkbench((s) => s.pendingStart[project.id]);
  const draftFocused = useWorkbench((s) => Boolean(s.draftFocused[project.id]));
  const selectProject = useWorkbench((s) => s.selectProject);
  const removeProject = useWorkbench((s) => s.removeProject);
  return {
    sessions,
    selected,
    activeSessionId,
    draft,
    pendingStart,
    draftFocused,
    selectProject,
    removeProject,
  };
}
