import { sandboxForAgent } from "@/features/chat/composer/access";
import { backend } from "@/lib/ipc";
import type { Session } from "@/types";
import {
  clearMissingSessionBanner,
  deselectSession,
  isMissingSessionError,
  loadArchivedSessions,
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
  const overrides = () => get().agentOverride;
  const showProject = async (id: string) => {
    const projects = await backend.listProjects();
    set({ projects, dialog: null });
    await get().selectProject(id);
  };
  return {
    projects: [],
    sessions: {},
    archivedSessions: {},
    showArchived: {},
    sidebarNotice: null,
    lifecycleBusy: null,
    selectedProjectId: null,
    activeSessionId: {},
    dialog: null,
    preferredAgent: null,
    agentOverride: {},

    releaseMissingSession(sessionId) {
      set((s) => ({
        sessions: withoutSession(s.sessions, sessionId),
        archivedSessions: withoutSession(s.archivedSessions, sessionId),
        activeSessionId: deselectSession(s.activeSessionId, sessionId),
        lifecycleBusy: s.lifecycleBusy === sessionId ? null : s.lifecycleBusy,
        lastError: null,
      }));
    },

    openDialog: (mode) => set({ dialog: mode, lastError: null }),
    closeDialog: () => set({ dialog: null, lastError: null }),

    async selectProject(id) {
      set({ selectedProjectId: id });
      const [pid, list] = await loadSessions(id, overrides);
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
        const [, list] = await loadSessions(projectId, overrides);
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
        if (isMissingSessionError(e)) get().releaseMissingSession(sessionId);
        else set({ lastError: String(e) });
      }
    },

    async toggleArchived(projectId) {
      if (get().showArchived[projectId]) {
        set((s) => ({ showArchived: { ...s.showArchived, [projectId]: false } }));
        return;
      }
      await get().viewArchived(projectId);
    },

    async viewArchived(projectId) {
      try {
        const [, list] = await loadArchivedSessions(projectId, overrides);
        set((s) => ({
          showArchived: { ...s.showArchived, [projectId]: true },
          archivedSessions: { ...s.archivedSessions, [projectId]: list },
        }));
      } catch (e) {
        set({ lastError: String(e) });
      }
    },

    async renameSession(sessionId, name) {
      try {
        await backend.renameSession(sessionId, name);
        const title = name.trim();
        set((s) => ({
          sessions: retitle(s.sessions, sessionId, title),
          archivedSessions: retitle(s.archivedSessions, sessionId, title),
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

    async archiveSession(projectId, sessionId) {
      try {
        await backend.setSessionArchived(sessionId, true);
        const [, list] = await loadSessions(projectId, overrides);
        const archived = get().showArchived[projectId]
          ? (await loadArchivedSessions(projectId, overrides))[1]
          : get().archivedSessions[projectId];
        set((s) => {
          const activeSessionId = { ...s.activeSessionId };
          if (activeSessionId[projectId] === sessionId) delete activeSessionId[projectId];
          return {
            sessions: { ...s.sessions, [projectId]: list },
            archivedSessions:
              archived !== undefined
                ? { ...s.archivedSessions, [projectId]: archived }
                : s.archivedSessions,
            activeSessionId,
            sidebarNotice: { kind: "archived", projectId, sessionId },
            lastError: null,
          };
        });
      } catch {
        set({ lastError: "无法归档对话" });
      }
    },

    async unarchiveSession(projectId, sessionId) {
      try {
        await backend.setSessionArchived(sessionId, false);
        const [, list] = await loadSessions(projectId, overrides);
        const [, archived] = await loadArchivedSessions(projectId, overrides);
        set((s) => ({
          sessions: { ...s.sessions, [projectId]: list },
          archivedSessions: { ...s.archivedSessions, [projectId]: archived },
          sidebarNotice: null,
          lastError: null,
        }));
        showInfo(set, "聊天已取消归档");
        await get().selectSession(projectId, sessionId);
      } catch {
        set({ lastError: "取消归档对话失败" });
      }
    },

    async undoArchive() {
      const notice = get().sidebarNotice;
      if (notice?.kind !== "archived") return;
      await get().unarchiveSession(notice.projectId, notice.sessionId);
    },

    async deleteSession(projectId, sessionId, archived) {
      try {
        await backend.deleteSession(sessionId);
        set((s) => {
          const activeSessionId = { ...s.activeSessionId };
          if (activeSessionId[projectId] === sessionId) delete activeSessionId[projectId];
          const drop = (list: Session[] | undefined) =>
            (list ?? []).filter((item) => item.id !== sessionId);
          return {
            sessions: { ...s.sessions, [projectId]: drop(s.sessions[projectId]) },
            archivedSessions: {
              ...s.archivedSessions,
              [projectId]: drop(s.archivedSessions[projectId]),
            },
            activeSessionId,
            lastError: null,
          };
        });
        showInfo(set, archived ? "已删除已归档的聊天" : "任务已删除");
        return true;
      } catch {
        return false;
      }
    },
  };
}
