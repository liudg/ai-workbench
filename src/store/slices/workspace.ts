import { agentForSession, reduceCatalogResult, type CatalogOutcome } from "@/lib/catalog";
import { backend } from "@/lib/ipc";
import { emptySandbox } from "@/types";
import { isMissingSessionError } from "../sync";
import type { WorkspaceSlice, WorkbenchGet, WorkbenchSet } from "../types";

function reportSessionError(get: WorkbenchGet, set: WorkbenchSet, sessionId: string, error: unknown) {
  if (isMissingSessionError(error)) {
    get().releaseMissingSession(sessionId);
    return;
  }
  set({ lastError: String(error) });
}

const catalogEpoch = new Map<string, number>();

export function createWorkspaceSlice(set: WorkbenchSet, get: WorkbenchGet): WorkspaceSlice {
  return {
    events: {},
    lastAccessMode: "full",
    accessMode: {},
    lastSandbox: emptySandbox(),
    sandboxes: {},
    attachments: {},
    pageAnnotations: {},
    queues: {},
    catalogs: {},
    catalogCache: {},
    catalogNotice: null,
    tuning: {},

    setSandbox(sessionId, sandbox) {
      const mode = sandbox.profileId ? "ask" : sandbox.mode;
      set((s) => ({
        lastAccessMode: mode,
        lastSandbox: sandbox,
        accessMode: { ...s.accessMode, [sessionId]: mode },
        sandboxes: { ...s.sandboxes, [sessionId]: sandbox },
      }));
      void backend.setSandbox(sessionId, sandbox).catch((e) => {
        reportSessionError(get, set, sessionId, e);
      });
    },

    async loadCatalog(sessionId) {
      const epoch = (catalogEpoch.get(sessionId) ?? 0) + 1;
      catalogEpoch.set(sessionId, epoch);
      const current = () => catalogEpoch.get(sessionId) === epoch;
      const agent = agentForSession(get().sessions, sessionId);

      let outcome: CatalogOutcome;
      try {
        const refresh = await backend.agentCatalog(sessionId);
        outcome = { ok: true as const, catalog: refresh.catalog, notice: refresh.notice };
      } catch (error) {
        outcome = { ok: false as const, message: String(error) };
      }
      if (!current()) return;

      const kind = agentForSession(get().sessions, sessionId) ?? agent;
      const reduced = reduceCatalogResult(
        {
          live: get().catalogs[sessionId],
          cached: kind ? get().catalogCache[kind] : undefined,
          notice: get().catalogNotice,
        },
        outcome,
      );
      set((s) => ({
        catalogs: reduced.live
          ? { ...s.catalogs, [sessionId]: reduced.live }
          : s.catalogs,
        catalogCache:
          kind && reduced.cached
            ? { ...s.catalogCache, [kind]: reduced.cached }
            : s.catalogCache,
        catalogNotice: reduced.notice,
      }));
    },

    setTuning(sessionId, model, effort, serviceTier) {
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
      try {
        await backend.sendMessage(sessionId, text, images, annotations);
      } catch (e) {
        reportSessionError(get, set, sessionId, e);
      }
    },

    async setCollaborationMode(sessionId, mode) {
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
      } catch (e) {
        reportSessionError(get, set, sessionId, e);
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
