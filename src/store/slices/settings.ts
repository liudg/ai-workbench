import { keepPreferredAgent } from "@/lib/agents";
import { backend } from "@/lib/ipc";
import type { SettingsSlice, WorkbenchGet, WorkbenchSet } from "../types";

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
      set({ updatingKind: kind });
      try {
        const next = await backend.updateAgent(kind);
        set((s) => {
          const installations = (s.installations ?? []).map((item) =>
            item.kind === kind ? next : item,
          );
          return {
            updatingKind: null,
            installations,
            preferredAgent: keepPreferredAgent(s.preferredAgent, installations),
          };
        });
      } catch (e) {
        const message = String(e);
        set((s) => ({
          updatingKind: null,
          installations: (s.installations ?? []).map((item) =>
            item.kind === kind ? { ...item, detail: message } : item,
          ),
        }));
      }
    },
  };
}
