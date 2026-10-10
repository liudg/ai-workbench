import { backend } from "@/lib/ipc";
import {
  clearMissingSessionBanner,
  loadSessions,
  mergeEvents,
} from "../sync";
import type { SidebarSlice, WorkbenchGet, WorkbenchSet } from "../types";

export function createSidebarSlice(set: WorkbenchSet, get: WorkbenchGet): SidebarSlice {
  const overrides = () => get().agentOverride;
  const showProject = async (id: string) => {
    const projects = await backend.listProjects();
    set({ projects, dialog: null });
    await get().selectProject(id);
  };
  return {
    projects: [],
    sessions: {},
    selectedProjectId: null,
    activeSessionId: {},
    dialog: null,
    preferredAgent: null,
    agentOverride: {},

    openDialog: (mode) => set({ dialog: mode, lastError: null }),
    closeDialog: () => set({ dialog: null, lastError: null }),

    async selectProject(id) {
      set({ selectedProjectId: id });
      const [pid, list] = await loadSessions(id, overrides);
      set((s) => ({ sessions: { ...s.sessions, [pid]: list } }));
      const activeId = get().activeSessionId[id];
      if (activeId && !get().events[activeId]) {
        const events = await backend.getSessionEvents(activeId);
        set((s) => ({ events: { ...s.events, [activeId]: events } }));
      }
    },

    async createProject(input) {
      try {
        const result = await backend.createProject(input);
        await showProject(result.project.id);
        return result.warning;
      } catch (e) {
        set({ lastError: String(e) });
        return null;
      }
    },

    async importProject(input) {
      try {
        const project = await backend.importProject(input);
        await showProject(project.id);
      } catch (e) {
        set({ lastError: String(e) });
      }
    },

    async removeProject(id) {
      await backend.removeProject(id);
      const projects = await backend.listProjects();
      set((s) => {
        const sessions = { ...s.sessions };
        delete sessions[id];
        const selectedProjectId =
          s.selectedProjectId === id
            ? (projects[0]?.id ?? null)
            : s.selectedProjectId;
        return { projects, sessions, selectedProjectId };
      });
      const next = get().selectedProjectId;
      if (next) await get().selectProject(next);
    },

    async createSession(projectId, agent) {
      try {
        const session = await backend.createSession(
          projectId,
          agent,
          get().lastAccessMode,
        );
        const [, list] = await loadSessions(projectId, overrides);
        set((s) => ({
          selectedProjectId: projectId,
          preferredAgent: agent,
          sessions: { ...s.sessions, [projectId]: list },
          activeSessionId: { ...s.activeSessionId, [projectId]: session.id },
          events: { ...s.events, [session.id]: s.events[session.id] ?? [] },
          accessMode: {
            ...s.accessMode,
            [session.id]: s.lastAccessMode,
          },
        }));
      } catch (e) {
        set({ lastError: String(e) });
      }
    },

    setSessionAgent(sessionId, agent) {
      set((s) => {
        const sessions: SidebarSlice["sessions"] = {};
        for (const [projectId, list] of Object.entries(s.sessions)) {
          sessions[projectId] = list.map((session) =>
            session.id === sessionId ? { ...session, agent } : session,
          );
        }
        return {
          preferredAgent: agent,
          agentOverride: { ...s.agentOverride, [sessionId]: agent },
          sessions,
        };
      });
      void backend.setSessionAgent(sessionId, agent);
    },

    async selectSession(projectId, sessionId) {
      set((s) => ({
        selectedProjectId: projectId,
        activeSessionId: { ...s.activeSessionId, [projectId]: sessionId },
      }));
      if (!get().sessions[projectId]) {
        const [pid, list] = await loadSessions(projectId, overrides);
        set((s) => ({ sessions: { ...s.sessions, [pid]: list } }));
      }
      try {
        const remote = await backend.getSessionEvents(sessionId);
        set((s) => {
          const merged = mergeEvents(s.events[sessionId], remote);
          return {
            events: {
              ...s.events,
              [sessionId]: merged,
            },
            lastError: clearMissingSessionBanner(s.lastError, merged),
          };
        });
      } catch (e) {
        set({ lastError: String(e) });
      }
    },
  };
}
