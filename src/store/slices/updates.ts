import { checkForUpdate, installUpdate } from "@/lib/updater";
import type { UpdatesSlice, WorkbenchSet } from "../types";

export function createUpdatesSlice(set: WorkbenchSet): UpdatesSlice {
  return {
    update: { kind: "idle" },
    updateDialogOpen: false,

    async checkUpdates(manual) {
      if (manual) {
        set({ updateDialogOpen: true, update: { kind: "checking" } });
      }
      await checkForUpdate((phase) => {
        set((s) => {
          if (
            s.update.kind === "downloading" &&
            (phase.kind === "checking" || phase.kind === "available")
          ) {
            return s;
          }
          const next: Partial<UpdatesSlice> = { update: phase };
          if (!manual && phase.kind === "available") {
            next.updateDialogOpen = true;
          }
          return next;
        });
      });
    },

    async startInstall() {
      await installUpdate((phase) => set({ update: phase }));
    },

    closeUpdateDialog() {
      set({ updateDialogOpen: false });
    },
  };
}
