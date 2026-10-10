import { agentForSession, reduceCatalogResult, type CatalogOutcome } from "@/lib/catalog";
import { backend } from "@/lib/ipc";
import { emptySandbox, type AgentCatalog } from "@/types";
import type { WorkspaceSlice, WorkbenchGet, WorkbenchSet } from "../types";

const catalogEpoch = new Map<string, number>();

function applyDefaultTuning(get: WorkbenchGet, sessionId: string, catalog: AgentCatalog) {
  if (get().tuning[sessionId] || catalog.models.length === 0) return;
  const model = catalog.models.find((item) => item.is_default) ?? catalog.models[0];
  const effort = model.default_effort || model.efforts[0]?.id || "";
  get().setTuning(sessionId, model.id, effort);
}

export function createWorkspaceSlice(set: WorkbenchSet, get: WorkbenchGet): WorkspaceSlice {
  return {
    events: {},
    lastAccessMode: "full",
    accessMode: {},
    lastSandbox: emptySandbox(),
    sandboxes: {},
    attachments: {},
    queues: {},
    catalogs: {},
    catalogCache: {},
    catalogNotice: null,
    tuning: {},
    composerSeed: null,

    setSandbox(sessionId, sandbox) {
      const mode = sandbox.profileId ? "ask" : sandbox.mode;
      set((s) => ({
        lastAccessMode: mode,
        lastSandbox: sandbox,
        accessMode: { ...s.accessMode, [sessionId]: mode },
        sandboxes: { ...s.sandboxes, [sessionId]: sandbox },
      }));
      void backend.setSandbox(sessionId, sandbox).catch((e) => {
        set({ lastError: String(e) });
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
      if (outcome.ok && reduced.live) applyDefaultTuning(get, sessionId, reduced.live);
    },

    setTuning(sessionId, model, effort) {
      set((s) => ({
        tuning: { ...s.tuning, [sessionId]: { model, effort } },
      }));
      void backend.setSessionTuning(sessionId, model, effort).catch((e) => {
        set({ lastError: String(e) });
      });
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

    seedComposer(sessionId, text, images) {
      set({
        composerSeed: {
          sessionId,
          text,
          images: images ?? [],
          token: Date.now(),
        },
      });
    },

    async sendMessage(sessionId, text, images) {
      try {
        await backend.sendMessage(sessionId, text, images);
      } catch (e) {
        set({ lastError: String(e) });
      }
    },

    async setCollaborationMode(sessionId, mode) {
      try {
        await backend.setCollaborationMode(sessionId, mode);
      } catch (e) {
        set({ lastError: String(e) });
      }
    },

    async startReview(sessionId, target) {
      try {
        await backend.startReview(sessionId, target);
      } catch (e) {
        set({ lastError: String(e) });
      }
    },

    async revertTurn(sessionId, turnId, text) {
      let rewound = false;
      try {
        await backend.revertTurn(sessionId, turnId);
        rewound = true;
        await backend.sendMessage(sessionId, text);
      } catch (e) {
        set({ lastError: String(e) });
        if (rewound) get().seedComposer(sessionId, text);
      }
    },

    async loadOlderHistory(sessionId) {
      const page = await backend.loadOlderHistory(sessionId);
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
        set({ lastError: String(e) });
      }
    },

    async stopSession(sessionId) {
      try {
        await backend.stopSession(sessionId);
      } catch (e) {
        set({ lastError: String(e) });
      }
    },
  };
}
