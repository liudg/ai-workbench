import { backend } from "@/lib/ipc";
import { isReadOnlyOpen } from "@/lib/utils";
import { emptyCatalog } from "@/types";
import { MISSING_SESSION } from "../sync";
import type { WorkspaceSlice, WorkbenchGet, WorkbenchSet } from "../types";

export function createWorkspaceSlice(set: WorkbenchSet, get: WorkbenchGet): WorkspaceSlice {
  return {
    events: {},
    lastAccessMode: "full",
    accessMode: {},
    attachments: {},
    catalogs: {},
    tuning: {},
    composerSeed: null,

    setAccessMode(sessionId, mode) {
      set((s) => ({
        lastAccessMode: mode,
        accessMode: { ...s.accessMode, [sessionId]: mode },
      }));
      void backend.setAccessMode(sessionId, mode).catch((e) => {
        set({ lastError: String(e) });
      });
    },

    async loadCatalog(sessionId) {
      if (get().catalogs[sessionId]) return;
      try {
        const catalog = await backend.agentCatalog(sessionId);
        set((s) => ({ catalogs: { ...s.catalogs, [sessionId]: catalog } }));
        if (!get().tuning[sessionId] && catalog.models.length > 0) {
          const model =
            catalog.models.find((item) => item.is_default) ?? catalog.models[0];
          const effort =
            model.default_effort || model.efforts[0]?.id || "";
          get().setTuning(sessionId, model.id, effort);
        }
      } catch (e) {
        const message = String(e);
        if (message === MISSING_SESSION) return;
        set((s) => {
          if (isReadOnlyOpen(s.events[sessionId])) return s;
          return {
            lastError: message,
            catalogs: { ...s.catalogs, [sessionId]: emptyCatalog() },
          };
        });
      }
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

    seedComposer(sessionId, text) {
      set({ composerSeed: { sessionId, text, token: Date.now() } });
    },

    async sendMessage(sessionId, text) {
      try {
        await backend.sendMessage(sessionId, text);
      } catch (e) {
        set({ lastError: String(e) });
      }
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
