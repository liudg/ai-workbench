import { persistedAgentKind } from "@/lib/agents";
import { userFacingMessage } from "@/lib/user-facing";
import { backend } from "@/lib/ipc";
import { forgetProjectDraft, type DraftCarryState } from "../draft-session";
import { keepSelectedProjectId, projectStillListed, STANDALONE_DRAFT_ID } from "../standalone";
import { clearMissingSessionBanner, loadSessions, loadWorkspaceLists } from "../sync";
import type { ShellSlice, WorkbenchGet, WorkbenchSet } from "../types";

let initStarted = false;

export function createShellSlice(set: WorkbenchSet, get: WorkbenchGet): ShellSlice {
  return {
    ready: false,
    lastError: null,
    screen: "workspace",

    async init() {
      if (initStarted) return;
      initStarted = true;
      backend.onSessionQueue((payload) => {
        set((s) => ({
          queues: { ...s.queues, [payload.session_id]: payload.items },
        }));
      });
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
        loadSessions(projectId).then(([pid, list]) =>
          set((s) => {
            if (s.drafts[pid]?.phase === "creating" || s.pendingStart[pid]) return {};
            return { sessions: { ...s.sessions, [pid]: list } };
          }),
        );
      });
      backend.onSessionRequest((request) => {
        void (async () => {
          const text = request.text?.trim() ?? "";
          if (!text) {
            get().openDraft(request.project_id, request.agent);
            return;
          }
          const created = await get().sendNewThread(request.project_id, request.agent, text);
          if (created && request.name) await get().renameSession(created, request.name);
        })();
      });
      backend.onProjectsChanged(() => {
        void loadWorkspaceLists().then(({ projects, pairs }) =>
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
        set({ lastError: userFacingMessage(e) });
      }
      await get().refreshInstallations();
      await get().refreshAll();
      const selected = get().selectedProjectId;
      if (selected === STANDALONE_DRAFT_ID) {
        if (!get().draftFocused[STANDALONE_DRAFT_ID]) {
          const agent =
            get().drafts[STANDALONE_DRAFT_ID]?.agent ??
            persistedAgentKind(get().installations, get().preferredAgent);
          if (agent) get().openDraft(STANDALONE_DRAFT_ID, agent);
        }
      } else if (selected) {
        await get().selectProject(selected);
      }
      window.setInterval(() => {
        void get().refreshAll();
      }, 20_000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void get().refreshAll();
      });
      get().checkUpdates(false);
    },

    async refreshAll() {
      const { projects, pairs } = await loadWorkspaceLists();
      set((s) => {
        const sessions = { ...s.sessions };
        const ids = new Set(projects.map((project) => project.id));
        for (const key of Object.keys(sessions)) {
          if (!projectStillListed(key, ids)) delete sessions[key];
        }
        const pendingStart = { ...s.pendingStart };
        for (const key of Object.keys(pendingStart)) {
          if (!projectStillListed(key, ids)) delete pendingStart[key];
        }
        for (const [pid, list] of pairs) {
          if (s.drafts[pid]?.phase === "creating" || pendingStart[pid]) continue;
          sessions[pid] = list;
        }
        let carried: DraftCarryState = {
          drafts: s.drafts,
          draftFocused: s.draftFocused,
          activeSessionId: s.activeSessionId,
          sessions,
          attachments: s.attachments,
          textSnippets: s.textSnippets,
          sandboxes: s.sandboxes,
          tuning: s.tuning,
          accessMode: s.accessMode,
          events: s.events,
          catalogs: s.catalogs,
          catalogNotices: s.catalogNotices,
          lastSandboxByAgent: s.lastSandboxByAgent,
          selectedProjectId: s.selectedProjectId,
          preferredAgent: s.preferredAgent,
        };
        for (const key of Object.keys(s.drafts)) {
          if (!projectStillListed(key, ids)) carried = forgetProjectDraft(carried, key);
        }
        const focusedProjectId =
          Object.keys(carried.draftFocused).find(
            (id) => id !== STANDALONE_DRAFT_ID && carried.draftFocused[id],
          ) ?? null;
        const selectedProjectId = keepSelectedProjectId({
          projects,
          current: carried.selectedProjectId,
          standaloneDraftFocused: Boolean(carried.draftFocused[STANDALONE_DRAFT_ID]),
          focusedProjectId,
        });
        return {
          projects,
          sessions: carried.sessions,
          selectedProjectId,
          drafts: carried.drafts,
          draftFocused: carried.draftFocused,
          attachments: carried.attachments,
          textSnippets: carried.textSnippets,
          sandboxes: carried.sandboxes,
          tuning: carried.tuning,
          accessMode: carried.accessMode,
          events: carried.events,
          catalogs: carried.catalogs,
          catalogNotices: carried.catalogNotices,
          pendingStart,
          ready: true,
        };
      });
    },

    clearError: () => set({ lastError: null }),
    openSettings: () => set({ screen: "settings" }),
    closeSettings: () => set({ screen: "workspace" }),
  };
}
