import { backend } from "@/lib/ipc";
import { clearMissingSessionBanner, loadSessions, loadWorkspaceLists } from "../sync";
import type { ShellSlice, WorkbenchGet, WorkbenchSet } from "../types";

let initStarted = false;

export function createShellSlice(set: WorkbenchSet, get: WorkbenchGet): ShellSlice {
  const overrides = () => get().agentOverride;
  return {
    ready: false,
    lastError: null,
    screen: "workspace",

    async init() {
      if (initStarted) return;
      initStarted = true;
      backend.onSessionEvent((event) => {
        set((s) => {
          const log = s.events[event.session_id] ?? [];
          const index = log.findIndex((item) => item.id === event.id);
          const next =
            index >= 0
              ? log.map((item, i) => (i === index ? event : item))
              : [...log, event];
          return {
            events: {
              ...s.events,
              [event.session_id]: next,
            },
            lastError: clearMissingSessionBanner(s.lastError, next),
          };
        });
      });
      backend.onSessionsChanged((projectId) => {
        loadSessions(projectId, overrides).then(([pid, list]) =>
          set((s) => ({ sessions: { ...s.sessions, [pid]: list } })),
        );
      });
      backend.onProjectsChanged(() => {
        void loadWorkspaceLists(overrides).then(({ projects, pairs }) =>
          set((s) => {
            const sessions = { ...s.sessions };
            for (const [pid, list] of pairs) sessions[pid] = list;
            return { projects, sessions };
          }),
        );
      });

      try {
        const profiles = await backend.agentProfiles();
        set({
          profiles: Object.fromEntries(profiles.map((profile) => [profile.kind, profile])),
        });
      } catch (e) {
        set({ lastError: String(e) });
      }
      void get().refreshInstallations();
      await get().refreshAll();
      const first = get().projects[0]?.id;
      if (first) await get().selectProject(first);
      window.setInterval(() => {
        void get().refreshAll();
      }, 20_000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void get().refreshAll();
      });
      get().checkUpdates(false);
    },

    async refreshAll() {
      const { projects, pairs } = await loadWorkspaceLists(overrides);
      set((s) => {
        const sessions = { ...s.sessions };
        const ids = new Set(projects.map((project) => project.id));
        for (const key of Object.keys(sessions)) {
          if (!ids.has(key)) delete sessions[key];
        }
        for (const [pid, list] of pairs) sessions[pid] = list;
        const selectedProjectId =
          s.selectedProjectId && ids.has(s.selectedProjectId)
            ? s.selectedProjectId
            : (projects[0]?.id ?? null);
        return { projects, sessions, selectedProjectId, ready: true };
      });
    },

    clearError: () => set({ lastError: null }),
    openSettings: () => set({ screen: "settings" }),
    closeSettings: () => set({ screen: "workspace" }),
  };
}
