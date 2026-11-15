import { useEffect, useState } from "react";

import { useTasks } from "@/features/tasks";
import {
  checkUpdates,
  closeUpdateDialog,
  countRunningSessions,
  retryUpdate,
  startInstall,
  useUpdateState,
} from "./update-store";

export function useUpdateDialog() {
  const open = useUpdateState((s) => s.dialogOpen);
  const update = useUpdateState((s) => s.phase);
  const { tasks } = useTasks();
  const runningSessions = countRunningSessions(tasks);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open || update.kind !== "available" || runningSessions === 0) {
      setConfirming(false);
    }
  }, [open, update.kind, runningSessions]);

  const requestInstall = () => {
    if (runningSessions > 0) {
      setConfirming(true);
      return;
    }
    void startInstall();
  };

  const confirmInstall = () => {
    setConfirming(false);
    void startInstall();
  };

  return {
    open,
    update,
    runningSessions,
    confirming,
    close: closeUpdateDialog,
    requestInstall,
    cancelConfirm: () => setConfirming(false),
    confirmInstall,
    retry: () => void retryUpdate(),
  };
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
