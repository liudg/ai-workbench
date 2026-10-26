import { useEffect } from "react";

import { checkUpdates, closeUpdateDialog, startInstall, useUpdateState } from "./update-store";

export function useUpdateDialog() {
  const open = useUpdateState((s) => s.dialogOpen);
  const update = useUpdateState((s) => s.phase);
  return { open, update, close: closeUpdateDialog, startInstall };
}

/** 侧栏菜单里的「检查更新」。 */
export function useUpdateCheck() {
  const checking = useUpdateState((s) => s.phase.kind === "checking");
  return { checking, checkNow: () => void checkUpdates(true) };
}

/** 启动时静默检查一次。 */
export function useStartupUpdateCheck() {
  useEffect(() => {
    void checkUpdates(false);
  }, []);
}
