import { initialSandbox } from "@/lib/sandbox";
import { userFacingMessage } from "@/lib/user-facing";
import { backend } from "@/lib/ipc";
import { draftId, isPendingId } from "../draft-session";
import { emptyProjectDraftUpdate, landOnEmptyProjectDraft } from "../lazy-draft";
import type { Session } from "@/types";
import { browserUnreadStorage, readUnreadFinishedIds } from "../unread-finished";
import {
  browserPinStorage,
  readPinnedSessionIds,
  togglePinnedSessionId,
  writePinnedSessionIds,
} from "../pinned-sessions";
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

function markArchived(groups: Record<string, Session[]>, sessionId: string, archived: boolean) {
  const next: Record<string, Session[]> = {};
  for (const [projectId, list] of Object.entries(groups)) {
    next[projectId] = list.map((session) =>
      session.id === sessionId ? { ...session, archived } : session,
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
    unreadFinishedIds: readUnreadFinishedIds(browserUnreadStorage()),
    sidebarNotice: null,
    lifecycleBusy: null,
    pinnedSessionIds: readPinnedSessionIds(browserPinStorage()),
    selectedProjectId: null,
    activeSessionId: {},
    dialog: null,
    preferredAgent: null,

    releaseMissingSession(sessionId) {
      set((s) => {
        const sessions = withoutSession(s.sessions, sessionId);
        const activeSessionId = deselectSession(s.activeSessionId, sessionId);
        const next = {
          sessions,
          activeSessionId,
          lifecycleBusy: s.lifecycleBusy === sessionId ? null : s.lifecycleBusy,
          lastError: null,
        };
        const projectId = s.selectedProjectId;
        if (!projectId) return next;
        const landed = landOnEmptyProjectDraft({ ...s, ...next }, projectId);
        return landed ? { ...next, ...emptyProjectDraftUpdate(landed) } : next;
      });
    },

    openDialog: (mode) => set({ dialog: mode, lastError: null }),
    closeDialog: () => set({ dialog: null, lastError: null }),

    async selectProject(id) {
      set({ selectedProjectId: id });
      void backend.warmProjectIndex(id).catch(() => undefined);
      const [pid, list] = await loadSessions(id);
      set((s) => {
        const sessions = { ...s.sessions, [pid]: list };
        if (s.selectedProjectId !== id) return { sessions };
        const landed = landOnEmptyProjectDraft({ ...s, sessions }, pid);
        return landed ? { sessions, ...emptyProjectDraftUpdate(landed) } : { sessions };
      });
      const activeId = get().activeSessionId[id];
      if (activeId && !get().events[activeId]) {
        try {
          const events = await backend.getSessionEvents(activeId);
          set((s) => ({
            events: { ...s.events, [activeId]: events },
            eventsReady: { ...s.eventsReady, [activeId]: true },
            lastError: clearMissingSessionBanner(s.lastError, events),
          }));
        } catch (error) {
          if (isMissingSessionError(error)) get().releaseMissingSession(activeId);
          else set({ lastError: userFacingMessage(error) });
        }
      }
    },

    async createProject(input) {
      try {
        const result = await backend.createProject(input);
        await showProject(result.project.id);
        return result.warning;
      } catch (e) {
        set({ lastError: userFacingMessage(e) });
        return null;
      }
    },

    async importProject(input) {
      try {
        const project = await backend.importProject(input);
        await showProject(project.id);
      } catch (e) {
        set({ lastError: userFacingMessage(e) });
      }
    },

    async removeProject(id) {
      await backend.removeProject(id);
      const projects = await backend.listProjects();
      set((s) => {
        const sessions = { ...s.sessions };
        delete sessions[id];
        const drafts = { ...s.drafts };
        const draftFocused = { ...s.draftFocused };
        delete drafts[id];
        delete draftFocused[id];
        const key = draftId(id);
        const dropKey = <T,>(map: Record<string, T>) => {
          if (!(key in map)) return map;
          const next = { ...map };
          delete next[key];
          return next;
        };
        const pendingStart = { ...s.pendingStart };
        delete pendingStart[id];
        const selectedProjectId =
          s.selectedProjectId === id
            ? (projects[0]?.id ?? null)
            : s.selectedProjectId;
        return {
          projects,
          sessions,
          selectedProjectId,
          drafts,
          draftFocused,
          attachments: dropKey(s.attachments),
          textSnippets: dropKey(s.textSnippets),
          sandboxes: dropKey(s.sandboxes),
          tuning: dropKey(s.tuning),
          accessMode: dropKey(s.accessMode),
          events: dropKey(s.events),
          catalogs: dropKey(s.catalogs),
          catalogNotices: dropKey(s.catalogNotices),
          pendingStart,
        };
      });
      const next = get().selectedProjectId;
      if (next) await get().selectProject(next);
    },

    async createSession(projectId, agent) {
      try {
        const sandbox = initialSandbox(
          get().lastSandboxByAgent[agent],
          get().profiles[agent]?.default_access,
        );
        const session = await backend.createSession(
          projectId,
          agent,
          sandbox ? (sandbox.profileId ? "ask" : sandbox.mode) : undefined,
        );
        if (
          sandbox &&
          (sandbox.networkAccess ||
            sandbox.writableRoots.length > 0 ||
            sandbox.profileId ||
            sandbox.mode === "approve-for-me")
        ) {
          try {
            await backend.setSandbox(session.id, sandbox);
          } catch (error) {
            if (isMissingSessionError(error)) get().releaseMissingSession(session.id);
            else set({ lastError: userFacingMessage(error) });
          }
        }
        const [, list] = await loadSessions(projectId);
        set((s) => ({
          selectedProjectId: projectId,
          preferredAgent: agent,
          sessions: { ...s.sessions, [projectId]: list },
          activeSessionId: { ...s.activeSessionId, [projectId]: session.id },
          events: { ...s.events, [session.id]: s.events[session.id] ?? [] },
          eventsReady: { ...s.eventsReady, [session.id]: true },
          accessMode: sandbox
            ? {
                ...s.accessMode,
                [session.id]: sandbox.profileId ? "ask" : sandbox.mode,
              }
            : s.accessMode,
          sandboxes: sandbox
            ? {
                ...s.sandboxes,
                [session.id]: sandbox,
              }
            : s.sandboxes,
          lastSandboxByAgent: sandbox
            ? { ...s.lastSandboxByAgent, [agent]: sandbox }
            : s.lastSandboxByAgent,
        }));
        return session.id;
      } catch (e) {
        set({ lastError: userFacingMessage(e) });
        return null;
      }
    },

    async selectSession(projectId, sessionId) {
      if (isPendingId(sessionId)) {
        const draft = get().drafts[projectId];
        if (draft) get().openDraft(projectId, draft.agent);
        return;
      }
      set((s) => ({
        selectedProjectId: projectId,
        activeSessionId: { ...s.activeSessionId, [projectId]: sessionId },
        draftFocused: { ...s.draftFocused, [projectId]: false },
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
            eventsReady: { ...s.eventsReady, [sessionId]: true },
            lastError: clearMissingSessionBanner(s.lastError, merged),
          };
        });
      } catch (e) {
        if (isMissingSessionError(e)) get().releaseMissingSession(sessionId);
        else set({ lastError: userFacingMessage(e) });
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

    togglePinnedSession(sessionId) {
      const pinnedSessionIds = togglePinnedSessionId(get().pinnedSessionIds, sessionId);
      writePinnedSessionIds(pinnedSessionIds, browserPinStorage());
      set({ pinnedSessionIds });
    },

    async archiveSession(projectId, sessionId, archived) {
      set({ lifecycleBusy: sessionId, lastError: null });
      try {
        await backend.setSessionArchived(sessionId, archived);
      } catch {
        set({
          lifecycleBusy: null,
          lastError: archived ? "无法归档。请重试" : "无法取消归档。请重试",
        });
        return false;
      }
      try {
        const [, list] = await loadSessions(projectId);
        set((s) => ({
          sessions: { ...s.sessions, [projectId]: list },
          lifecycleBusy: null,
        }));
      } catch {
        set((s) => ({
          sessions: markArchived(s.sessions, sessionId, archived),
          lifecycleBusy: null,
        }));
      }
      return true;
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
          const sessions = {
            ...s.sessions,
            [projectId]: (s.sessions[projectId] ?? []).filter((item) => item.id !== sessionId),
          };
          const next = { sessions, activeSessionId, lastError: null };
          const landed = landOnEmptyProjectDraft({ ...s, ...next }, projectId);
          return landed ? { ...next, ...emptyProjectDraftUpdate(landed) } : next;
        });
        showInfo(set, "任务已删除");
        return true;
      } catch {
        return false;
      }
    },
  };
}
