import { useEffect, useState } from "react";

import { useTasks } from "@/features/tasks";
import { APP_VERSION } from "@/lib/version";
import {
  accountMenuUpdate,
  checkUpdates,
  closeUpdateDialog,
  countRunningSessions,
  dismissUpdate,
  downloadProgress,
  openOrCheckUpdates,
  openUpdateDialog,
  recheckUpdates,
  retryUpdate,
  startDownload,
  startInstall,
  titlebarUpdatePill,
  useUpdateState,
} from "./update-store";

export function useUpdateDialogOpen(): boolean {
  return useUpdateState((s) => s.dialogOpen);
}

export function useUpdateDialog() {
  const update = useUpdateState((s) => s.phase);
  const { tasks } = useTasks();
  const runningSessions = update.kind === "downloaded" ? countRunningSessions(tasks) : 0;
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (update.kind !== "downloaded" || runningSessions === 0) {
      setConfirming(false);
    }
  }, [update.kind, runningSessions]);

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

  const progress =
    update.kind === "downloading"
      ? downloadProgress(update.received, update.total)
      : null;

  return {
    appVersion: APP_VERSION,
    update,
    progress,
    runningSessions,
    confirming,
    close: closeUpdateDialog,
    dismiss: dismissUpdate,
    requestDownload: () => void startDownload(),
    requestInstall,
    cancelConfirm: () => setConfirming(false),
    confirmInstall,
    retry: () => void retryUpdate(),
    recheck: () => void recheckUpdates(),
  };
}

/** 顶栏右侧轻量更新胶囊，点击统一打开更新对话框。 */
export function useTitlebarUpdatePill() {
  const phase = useUpdateState((s) => s.phase);
  const dismissedVersion = useUpdateState((s) => s.dismissedVersion);
  const pill = titlebarUpdatePill({ phase, dialogOpen: false, dismissedVersion });
  return { pill, openDialog: openUpdateDialog };
}

/** 侧栏左下角菜单里的更新项与触发器圆点。 */
export function useUpdateCheck() {
  const phase = useUpdateState((s) => s.phase);
  const view = accountMenuUpdate(phase, APP_VERSION);
  return { ...view, checkNow: () => void openOrCheckUpdates() };
}

/** 启动时静默检查一次。 */
export function useStartupUpdateCheck() {
  useEffect(() => {
    void checkUpdates(false);
  }, []);
}
