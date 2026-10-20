import { useWorkbench } from "@/store";
import type { AgentCatalog, AgentKind, AgentProfile } from "@/types";

import type { PaletteCaps } from "./commands";

/** 命令菜单读工作台状态。展示组件只拿这里的结果。 */
export function useCommandMenuState() {
  const projects = useWorkbench((s) => s.projects);
  const sessions = useWorkbench((s) => s.sessions);
  const selectedProjectId = useWorkbench((s) => s.selectedProjectId);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const pinnedSessionIds = useWorkbench((s) => s.pinnedSessionIds);
  const installations = useWorkbench((s) => s.installations);
  const preferredAgent = useWorkbench((s) => s.preferredAgent);
  const catalogs = useWorkbench((s) => s.catalogs);
  const profiles = useWorkbench((s) => s.profiles);
  const draftFocused = useWorkbench((s) =>
    selectedProjectId ? Boolean(s.draftFocused[selectedProjectId]) : false,
  );
  return {
    projects,
    sessions,
    selectedProjectId,
    activeSessionId,
    pinnedSessionIds,
    installations,
    preferredAgent,
    catalogs,
    profiles,
    draftFocused,
    read: () => useWorkbench.getState(),
  };
}

export function attentionInput(state: ReturnType<typeof useWorkbench.getState>) {
  const projectId = state.selectedProjectId;
  const draftOn = projectId ? Boolean(state.draftFocused[projectId]) : false;
  const currentId = !projectId || draftOn ? null : (state.activeSessionId[projectId] ?? null);
  return {
    projects: state.projects,
    pinnedProjectIds: state.pinnedProjectIds,
    sessions: state.sessions,
    pinnedSessionIds: state.pinnedSessionIds,
    events: state.events,
    eventsReady: state.eventsReady,
    unreadFinishedIds: state.unreadFinishedIds,
    currentId,
  };
}

export function flashSidebarNotice(text: string) {
  const token = Date.now();
  useWorkbench.setState({ sidebarNotice: { kind: "info", text, token } });
  window.setTimeout(() => {
    const current = useWorkbench.getState().sidebarNotice;
    if (current?.kind === "info" && current.token === token) {
      useWorkbench.setState({ sidebarNotice: null });
    }
  }, 4000);
}

export function sessionCaps(
  sessionId: string | null,
  agent: AgentKind | null,
  catalogs: Record<string, AgentCatalog>,
  profiles: Partial<Record<AgentKind, AgentProfile>>,
): PaletteCaps | null {
  if (!sessionId || !agent) return null;
  const catalog = catalogs[sessionId]?.capabilities;
  if (catalog) return catalog;
  const profile = profiles[agent];
  if (profile?.kind === agent) return profile.capabilities;
  return null;
}
