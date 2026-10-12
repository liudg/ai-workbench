import { sandboxForAgent } from "@/features/chat/composer/access";
import { backend } from "@/lib/ipc";
import type { Session } from "@/types";
import {
  clearMissingSessionBanner,
  deselectSession,
  isMissingSessionError,
  loadSessions,
  mergeEvents,
  withoutSession,
} from "../sync";
import type { SidebarNotice, SidebarSlice, WorkbenchGet, WorkbenchSet } from "../types";

let noticeToken = 0;

function showInfo(set: WorkbenchSet, text: string) {
  const token = ++noticeToken;
  const notice: SidebarNotice = { kind: "info", text, token };
  set({ sidebarNotice: notice });
  window.setTimeout(() => {
    set((s) =>
      s.sidebarNotice?.kind === "info" && s.sidebarNotice.token === token
        ? { sidebarNotice: null }
        : {},
    );
  }, 4000);
}

function retitle(groups: Record<string, Session[]>, sessionId: string, title: string) {
  const next: Record<string, Session[]> = {};
  for (const [projectId, list] of Object.entries(groups)) {
    next[projectId] = list.map((session) =>
      session.id === sessionId ? { ...session, title } : session,
    );
  }
  return next;
}

export function createSidebarSlice(set: WorkbenchSet, get: WorkbenchGet): SidebarSlice {
  const showProject = async (id: string) => {
    const projects = await backend.listProjects();
    set({ projects, dialog: null });
    await get().selectProject(id);
  };
  return {
    projects: [],
    sessions: {},
    sidebarNotice: null,
    lifecycleBusy: null,
    selectedProjectId: null,
    activeSessionId: {},
    dialog: null,
    preferredAgent: null,

    releaseMissingSession(sessionId) {
      set((s) => ({
        sessions: withoutSession(s.sessions, sessionId),
        activeSessionId: deselectSession(s.activeSessionId, sessionId),
        lifecycleBusy: s.lifecycleBusy === sessionId ? null : s.lifecycleBusy,
        lastError: null,
      }));
    },

    openDialog: (mode) => set({ dialog: mode, lastError: null }),
    closeDialog: () => set({ dialog: null, lastError: null }),

    async selectProject(id) {
      set({ selectedProjectId: id });
      const [pid, list] = await loadSessions(id);
      set((s) => ({ sessions: { ...s.sessions, [pid]: list } }));
      const activeId = get().activeSessionId[id];
      if (activeId && !get().events[activeId]) {
        try {
          const events = await backend.getSessionEvents(activeId);
          set((s) => ({
            events: { ...s.events, [activeId]: events },
            lastError: clearMissingSessionBanner(s.lastError, events),
          }));
        } catch (error) {
          if (isMissingSessionError(error)) get().releaseMissingSession(activeId);
          else set({ lastError: String(error) });
        }
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
        const sandbox = sandboxForAgent(
          get().lastSandbox,
          get().profiles[agent]?.capabilities,
        );
        const session = await backend.createSession(
          projectId,
          agent,
          sandbox.profileId ? "ask" : sandbox.mode,
        );
        if (
          sandbox.networkAccess ||
          sandbox.writableRoots.length > 0 ||
          sandbox.profileId ||
          sandbox.mode === "approve-for-me"
        ) {
          try {
            await backend.setSandbox(session.id, sandbox);
          } catch (error) {
            if (isMissingSessionError(error)) get().releaseMissingSession(session.id);
            else set({ lastError: String(error) });
          }
        }
        const [, list] = await loadSessions(projectId);
        set((s) => ({
          selectedProjectId: projectId,
          preferredAgent: agent,
          sessions: { ...s.sessions, [projectId]: list },
          activeSessionId: { ...s.activeSessionId, [projectId]: session.id },
          events: { ...s.events, [session.id]: s.events[session.id] ?? [] },
          accessMode: {
            ...s.accessMode,
            [session.id]: sandbox.profileId ? "ask" : sandbox.mode,
          },
          sandboxes: {
            ...s.sandboxes,
            [session.id]: sandbox,
          },
          lastSandbox: sandbox,
          lastAccessMode: sandbox.profileId ? "ask" : sandbox.mode,
        }));
        return session.id;
      } catch (e) {
        set({ lastError: String(e) });
        return null;
      }
    },

    async selectSession(projectId, sessionId) {
      set((s) => ({
        selectedProjectId: projectId,
        activeSessionId: { ...s.activeSessionId, [projectId]: sessionId },
      }));
      if (!get().sessions[projectId]) {
        const [pid, list] = await loadSessions(projectId);
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
        if (isMissingSessionError(e)) get().releaseMissingSession(sessionId);
        else set({ lastError: String(e) });
      }
    },

    async renameSession(sessionId, name) {
      try {
        await backend.renameSession(sessionId, name);
        const title = name.trim();
        set((s) => ({
          sessions: retitle(s.sessions, sessionId, title),
        }));
        return true;
      } catch {
        return false;
      }
    },

    async forkSession(projectId, sessionId) {
      set({ lifecycleBusy: sessionId, lastError: null });
      try {
        const created = await backend.forkSession(sessionId);
        set((s) => {
          const list = s.sessions[projectId] ?? [];
          const next = [...list.filter((item) => item.id !== created.id), created].sort(
            (a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at,
          );
          return {
            sessions: { ...s.sessions, [projectId]: next },
            lifecycleBusy: null,
          };
        });
        await get().selectSession(projectId, created.id);
      } catch {
        set({ lifecycleBusy: null, lastError: "创建聊天分支失败" });
      }
    },

    async deleteSession(projectId, sessionId) {
      try {
        await backend.deleteSession(sessionId);
        set((s) => {
          const activeSessionId = { ...s.activeSessionId };
          if (activeSessionId[projectId] === sessionId) delete activeSessionId[projectId];
          const drop = (list: Session[] | undefined) =>
            (list ?? []).filter((item) => item.id !== sessionId);
          return {
            sessions: { ...s.sessions, [projectId]: drop(s.sessions[projectId]) },
            activeSessionId,
            lastError: null,
          };
        });
        showInfo(set, "任务已删除");
        return true;
      } catch {
        return false;
      }
    },
  };
}
