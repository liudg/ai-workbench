// 应用更新的进度和对话框开关。整个应用一份。

import { create } from "zustand";

import {
  checkForUpdate,
  hasPendingUpdate,
  installUpdate,
  relaunchAfterUpdate,
  type UpdatePhase,
  type UpdaterRuntime,
} from "../../lib/native/updater.ts";

export interface BusySessionTask {
  sessions: readonly { status: string }[];
  sides?: readonly { status: string }[];
}

function isSessionBusy(status: string): boolean {
  return status === "starting" || status === "running" || status === "needs-input";
}

/** 统计仍在运行或等待输入的会话数，口径与 daemon /health 的 running_sessions 一致。 */
export function countRunningSessions(tasks: readonly BusySessionTask[]): number {
  let count = 0;
  for (const task of tasks) {
    for (const session of task.sessions) {
      if (isSessionBusy(session.status)) count += 1;
    }
    if (task.sides) {
      for (const side of task.sides) {
        if (isSessionBusy(side.status)) count += 1;
      }
    }
  }
  return count;
}

interface UpdateState {
  phase: UpdatePhase;
  dialogOpen: boolean;
}

const useUpdateStore = create<UpdateState>()(() => ({
  phase: { kind: "idle" },
  dialogOpen: false,
}));

function isBusyInstall(phase: UpdatePhase): boolean {
  return (
    phase.kind === "downloading" ||
    phase.kind === "ready" ||
    (phase.kind === "error" && phase.stage === "restart")
  );
}

function setPhase(phase: UpdatePhase) {
  useUpdateStore.setState({ phase });
}

/**
 * 检查更新：
 * - 正在下载、已就绪待重启或重启失败时绝不覆盖进度，也不重新拉取远端（手动点击仅重新打开弹窗查看进度）；
 * - 手动检查时立即打开对话框；自动检查只在发现新版本时弹出。
 */
export async function checkUpdates(
  manual: boolean,
  runtime?: UpdaterRuntime,
): Promise<void> {
  const current = useUpdateStore.getState();
  if (isBusyInstall(current.phase)) {
    if (manual && !current.dialogOpen) {
      useUpdateStore.setState({ dialogOpen: true });
    }
    return;
  }
  if (current.phase.kind === "checking") {
    if (manual && !current.dialogOpen) {
      useUpdateStore.setState({ dialogOpen: true });
    }
    return;
  }

  if (manual) {
    useUpdateStore.setState({ dialogOpen: true, phase: { kind: "checking" } });
  }
  await checkForUpdate((phase) => {
    useUpdateStore.setState((state) => {
      if (isBusyInstall(state.phase)) return state;
      return {
        phase,
        dialogOpen: state.dialogOpen || (!manual && phase.kind === "available"),
      };
    });
  }, runtime);
}

export function startInstall(runtime?: UpdaterRuntime): Promise<void> {
  const current = useUpdateStore.getState().phase;
  if (isBusyInstall(current)) return Promise.resolve();
  return installUpdate(setPhase, runtime);
}

export function retryUpdate(runtime?: UpdaterRuntime): Promise<void> {
  const current = useUpdateStore.getState().phase;
  // 已经装好、只是重启没成功：重试只重启，不再下载。
  if (current.kind === "error" && current.stage === "restart") {
    return relaunchAfterUpdate(setPhase, current.version, runtime);
  }
  if (current.kind === "error" && current.stage === "install" && hasPendingUpdate()) {
    return startInstall(runtime);
  }
  return checkUpdates(true, runtime);
}

export function closeUpdateDialog() {
  useUpdateStore.setState({ dialogOpen: false });
}

export function useUpdateState<T>(select: (state: UpdateState) => T): T {
  return useUpdateStore(select);
}

/** 仅供测试读取与重置状态。 */
export function getUpdateStateSnapshot(): UpdateState {
  return useUpdateStore.getState();
}

export function resetUpdateStoreForTest() {
  useUpdateStore.setState({ phase: { kind: "idle" }, dialogOpen: false });
}
