import { useWorkbench } from "@/store";
import { pendingSidebarSession } from "@/store/draft-session";
import { standaloneChatSessions, STANDALONE_DRAFT_ID } from "@/store/standalone";

export function useChatGroup() {
  const projects = useWorkbench((s) => s.projects);
  const sessions = useWorkbench((s) => s.sessions);
  const selectedProjectId = useWorkbench((s) => s.selectedProjectId);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const draft = useWorkbench((s) => s.drafts[STANDALONE_DRAFT_ID]);
  const pendingStart = useWorkbench((s) => s.pendingStart[STANDALONE_DRAFT_ID]);
  const draftFocused = useWorkbench((s) => Boolean(s.draftFocused[STANDALONE_DRAFT_ID]));
  const chats = standaloneChatSessions(projects, sessions);
  const pending = pendingSidebarSession(STANDALONE_DRAFT_ID, draft, pendingStart);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const activeId =
    draftFocused && pending
      ? pending.id
      : selectedProject?.standalone
        ? activeSessionId[selectedProject.id]
        : undefined;
  return { chats, pending, activeId };
}
