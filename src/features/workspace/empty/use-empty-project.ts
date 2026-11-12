import { openNewSession, openProjectDialog } from "@/shared/shell/navigation";

export function useEmptyProject() {
  return {
    openDialog: openProjectDialog,
    startStandalone: () => openNewSession(null),
  };
}
