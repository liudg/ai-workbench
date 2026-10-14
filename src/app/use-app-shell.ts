import { useEffect } from "react";

import { useWorkbench } from "@/store";
import { visibleBanner } from "@/store/sync";

export function useAppShell() {
  const ready = useWorkbench((s) => s.ready);
  const init = useWorkbench((s) => s.init);
  const lastError = useWorkbench((s) => visibleBanner(s.lastError));
  const dialogOpen = useWorkbench((s) => s.dialog !== null);
  const clearError = useWorkbench((s) => s.clearError);

  useEffect(() => {
    init();
  }, [init]);

  return { ready, lastError, dialogOpen, clearError };
}
