import { reduceCatalogResult, type CatalogOutcome } from "@/lib/catalog";
import { userFacingMessage } from "@/lib/user-facing";
import { backend } from "@/lib/ipc";
import { withTextSnippet, withoutTextSnippet } from "@/shared/text-snippet";
import type { AgentKind } from "@/types";
import { composerDraftsAfterSend, rememberSessionComposerDraft } from "../composer-draft";
import { isDraftId } from "../draft-session";
import { isMissingSessionError } from "../sync";
import type { WorkspaceSlice, WorkbenchGet, WorkbenchSet } from "../types";

function agentForSession(get: WorkbenchGet, sessionId: string): AgentKind | undefined {
  for (const list of Object.values(get().sessions)) {
    const found = list.find((session) => session.id === sessionId);
    if (found) return found.agent;
  }
  return undefined;
}

function reportSessionError(get: WorkbenchGet, set: WorkbenchSet, sessionId: string, error: unknown) {
  if (isMissingSessionError(error)) {
    get().releaseMissingSession(sessionId);
    return;
  }
  set({ lastError: userFacingMessage(error) });
}

const catalogEpoch = new Map<string, number>();

export function createWorkspaceSlice(set: WorkbenchSet, get: WorkbenchGet): WorkspaceSlice {
  return {
    events: {},
    eventsReady: {},
    accessMode: {},
    lastSandboxByAgent: {},
    sandboxes: {},
    attachments: {},
    textSnippets: {},
    composerDraftBySession: {},
    pageAnnotations: {},
    queues: {},
    catalogs: {},
    catalogNotices: {},
    tuning: {},

    setSandbox(sessionId, sandbox) {
      if (isDraftId(sessionId)) {
        get().setDraftSandbox(sessionId, sandbox);
        return;
      }
      const mode = sandbox.profileId ? "ask" : sandbox.mode;
      const agent = agentForSession(get, sessionId);
      set((s) => ({
        accessMode: { ...s.accessMode, [sessionId]: mode },
        sandboxes: { ...s.sandboxes, [sessionId]: sandbox },
        lastSandboxByAgent: agent
          ? { ...s.lastSandboxByAgent, [agent]: sandbox }
          : s.lastSandboxByAgent,
      }));
      void backend.setSandbox(sessionId, sandbox).catch((e) => {
        reportSessionError(get, set, sessionId, e);
      });
    },

    async loadCatalog(sessionId) {
      if (isDraftId(sessionId)) {
        await get().loadDraftCatalog(sessionId);
        return;
      }
      const epoch = (catalogEpoch.get(sessionId) ?? 0) + 1;
      catalogEpoch.set(sessionId, epoch);
      const current = () => catalogEpoch.get(sessionId) === epoch;
      let outcome: CatalogOutcome;
      try {
        const refresh = await backend.agentCatalog(sessionId);
        outcome = { ok: true as const, catalog: refresh.catalog, notice: refresh.notice };
      } catch (error) {
        outcome = { ok: false as const, message: userFacingMessage(error) ?? "" };
      }
      if (!current()) return;

      const reduced = reduceCatalogResult(
        {
          live: get().catalogs[sessionId],
          notice: get().catalogNotices[sessionId] ?? null,
        },
        outcome,
      );
      set((s) => {
        const catalogs = { ...s.catalogs };
        const catalogNotices = { ...s.catalogNotices };
        if (reduced.live) catalogs[sessionId] = reduced.live;
        else delete catalogs[sessionId];
        if (reduced.notice) catalogNotices[sessionId] = reduced.notice;
        else delete catalogNotices[sessionId];
        return { catalogs, catalogNotices };
      });
    },

    setTuning(sessionId, model, effort, serviceTier) {
      if (isDraftId(sessionId)) {
        get().setDraftTuning(sessionId, model, effort, serviceTier);
        return;
      }
      set((s) => {
        const previous = s.tuning[sessionId];
        const nextTier = serviceTier === undefined ? previous?.serviceTier : serviceTier;
        return {
          tuning: {
            ...s.tuning,
            [sessionId]: { model, effort, ...(nextTier !== undefined ? { serviceTier: nextTier } : {}) },
          },
        };
      });
      void backend.setSessionTuning(sessionId, model, effort).catch((e) => {
        reportSessionError(get, set, sessionId, e);
      });
      if (serviceTier !== undefined) {
        void backend.setSessionServiceTier(sessionId, serviceTier).catch((e) => {
          reportSessionError(get, set, sessionId, e);
        });
      }
    },

    addAttachments(sessionId, files) {
      set((s) => {
        const current = s.attachments[sessionId] ?? [];
        const seen = new Set(current.map((file) => file.path));
        const next = [...current];
        for (const file of files) {
          if (!seen.has(file.path)) {
            seen.add(file.path);
            next.push(file);
          }
        }
        return { attachments: { ...s.attachments, [sessionId]: next } };
      });
    },

    removeAttachment(sessionId, path) {
      set((s) => ({
        attachments: {
          ...s.attachments,
          [sessionId]: (s.attachments[sessionId] ?? []).filter(
            (file) => file.path !== path,
          ),
        },
      }));
    },

    clearAttachments(sessionId) {
      set((s) => ({
        attachments: { ...s.attachments, [sessionId]: [] },
      }));
    },

    replaceAttachments(sessionId, files) {
      set((s) => ({
        attachments: { ...s.attachments, [sessionId]: files },
      }));
    },

    addTextSnippet(sessionId, snippet) {
      if (!sessionId) return;
      set((s) => {
        const current = s.textSnippets[sessionId] ?? [];
        const next = withTextSnippet(current, snippet);
        if (next === current) return {};
        return { textSnippets: { ...s.textSnippets, [sessionId]: next } };
      });
    },

    removeTextSnippet(sessionId, id) {
      set((s) => ({
        textSnippets: {
          ...s.textSnippets,
          [sessionId]: withoutTextSnippet(s.textSnippets[sessionId] ?? [], id),
        },
      }));
    },

    clearTextSnippets(sessionId) {
      const ids = (get().textSnippets[sessionId] ?? []).map((item) => item.id);
      for (const id of ids) get().removeTextSnippet(sessionId, id);
    },

    rememberComposerDraft(sessionId, text) {
      set((s) => {
        const next = rememberSessionComposerDraft(s.composerDraftBySession, sessionId, text);
        if (next === s.composerDraftBySession) return {};
        return { composerDraftBySession: next };
      });
    },

    clearSentComposerDraft(sessionId, previousText, sentText) {
      set((s) => {
        const next = composerDraftsAfterSend(
          s.composerDraftBySession,
          sessionId,
          previousText,
          sentText,
          true,
        );
        if (next === s.composerDraftBySession) return {};
        return { composerDraftBySession: next };
      });
    },

    addPageAnnotation(sessionId, note) {
      set((s) => {
        const current = s.pageAnnotations[sessionId] ?? [];
        if (current.some((item) => item.id === note.id)) return {};
        return {
          pageAnnotations: {
            ...s.pageAnnotations,
            [sessionId]: [...current, note],
          },
        };
      });
    },

    removePageAnnotation(sessionId, id) {
      set((s) => ({
        pageAnnotations: {
          ...s.pageAnnotations,
          [sessionId]: (s.pageAnnotations[sessionId] ?? []).filter((item) => item.id !== id),
        },
      }));
    },

    clearPageAnnotations(sessionId) {
      set((s) => ({
        pageAnnotations: { ...s.pageAnnotations, [sessionId]: [] },
      }));
    },

    async sendMessage(sessionId, text, images, annotations) {
      if (isDraftId(sessionId)) {
        return get().commitDraftMessage(sessionId, text, images, annotations);
      }
      try {
        await backend.sendMessage(sessionId, text, images, annotations);
        return true;
      } catch (e) {
        reportSessionError(get, set, sessionId, e);
        return false;
      }
    },

    async setCollaborationMode(sessionId, mode) {
      if (isDraftId(sessionId)) {
        get().setDraftCollaboration(sessionId, mode);
        return;
      }
      try {
        await backend.setCollaborationMode(sessionId, mode);
      } catch (e) {
        reportSessionError(get, set, sessionId, e);
      }
    },

    async startReview(sessionId, target) {
      try {
        await backend.startReview(sessionId, target);
      } catch (e) {
        reportSessionError(get, set, sessionId, e);
      }
    },

    async loadOlderHistory(sessionId) {
      let page;
      try {
        page = await backend.loadOlderHistory(sessionId);
      } catch (error) {
        if (isMissingSessionError(error)) {
          get().releaseMissingSession(sessionId);
          return true;
        }
        throw error;
      }
      set((s) => {
        const current = s.events[sessionId] ?? [];
        const ids = new Set(page.events.map((event) => event.id));
        const maxSeq = page.events.reduce((max, event) => Math.max(max, event.seq), 0);
        const extra = current.filter((event) => !ids.has(event.id) && event.seq > maxSeq);
        return {
          events: {
            ...s.events,
            [sessionId]: extra.length > 0 ? [...page.events, ...extra] : page.events,
          },
        };
      });
      return page.exhausted;
    },

    async answerPrompt(sessionId, promptId, answer) {
      try {
        await backend.answerPrompt(sessionId, promptId, answer);
        return true;
      } catch (e) {
        reportSessionError(get, set, sessionId, e);
        return false;
      }
    },

    async stopSession(sessionId) {
      try {
        await backend.stopSession(sessionId);
      } catch (e) {
        reportSessionError(get, set, sessionId, e);
      }
    },
  };
}
