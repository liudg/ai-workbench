// 应用更新的进度和对话框开关。整个应用一份。

import { create } from "zustand";

import { checkForUpdate, installUpdate, type UpdatePhase } from "@/lib/updater";

interface UpdateState {
  phase: UpdatePhase;
  dialogOpen: boolean;
}

const useUpdateStore = create<UpdateState>()(() => ({ phase: { kind: "idle" }, dialogOpen: false }));

/** 正在下载时再检查一次，不把进度盖掉。 */
function keepDownload(current: UpdatePhase, next: UpdatePhase) {
  return current.kind === "downloading" && (next.kind === "checking" || next.kind === "available");
}

/** 手动检查时马上打开对话框；自动检查只在有新版本时打开。 */
export async function checkUpdates(manual: boolean) {
  if (manual) useUpdateStore.setState({ dialogOpen: true, phase: { kind: "checking" } });
  await checkForUpdate((phase) => {
    useUpdateStore.setState((state) => {
      if (keepDownload(state.phase, phase)) return state;
      return { phase, dialogOpen: state.dialogOpen || (!manual && phase.kind === "available") };
    });
  });
}

export function startInstall() {
  return installUpdate((phase) => useUpdateStore.setState({ phase }));
}

export function closeUpdateDialog() {
  useUpdateStore.setState({ dialogOpen: false });
}

export function useUpdateState<T>(select: (state: UpdateState) => T): T {
  return useUpdateStore(select);
}
