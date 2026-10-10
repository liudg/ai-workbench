import { checkForUpdate, installUpdate, type UpdatePhase } from "@/lib/updater";
import type { UpdatesSlice, WorkbenchSet } from "../types";

function keepCurrentDownload(current: UpdatePhase, next: UpdatePhase) {
  return (
    current.kind === "downloading" &&
    (next.kind === "checking" || next.kind === "available")
  );
}

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
          if (keepCurrentDownload(s.update, phase)) return s;
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
