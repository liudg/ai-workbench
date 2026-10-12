import { keepPreferredAgent } from "@/lib/agents";
import { backend } from "@/lib/ipc";
import type { SettingsSlice, WorkbenchGet, WorkbenchSet } from "../types";

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "更新失败";
}

export function createSettingsSlice(set: WorkbenchSet, get: WorkbenchGet): SettingsSlice {
  return {
    installations: null,
    installationsLoading: false,
    installationError: null,
    updatingKind: null,
    profiles: {},

    async refreshInstallations() {
      set({ installationsLoading: true });
      try {
        const installations = await backend.listAgentInstallations();
        set((s) => ({
          installations,
          installationsLoading: false,
          installationError: null,
          preferredAgent: keepPreferredAgent(s.preferredAgent, installations),
        }));
      } catch (e) {
        set({
          installationsLoading: false,
          installationError: String(e),
          installations: get().installations ?? [],
        });
      }
    },

    async updateInstallation(kind) {
      set({ updatingKind: kind, installationError: null });
      try {
        const next = await backend.updateAgent(kind);
        set((s) => {
          const installations = (s.installations ?? []).map((item) =>
            item.kind === kind ? next : item,
          );
          return {
            updatingKind: null,
            installationError: null,
            installations,
            preferredAgent: keepPreferredAgent(s.preferredAgent, installations),
          };
        });
      } catch (e) {
        set({ updatingKind: null, installationError: errorText(e) });
      }
    },
  };
}
