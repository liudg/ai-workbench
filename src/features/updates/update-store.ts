// 应用更新的进度、轻量胶囊与对话框状态。整个应用一份。

import { create } from "zustand";

import {
  checkForUpdate,
  discardPendingUpdate,
  downloadUpdate,
  hasDownloadedUpdate,
  hasPendingUpdate,
  installDownloadedUpdate,
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

export function formatUpdateSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function downloadPercent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((received / total) * 100));
}

export interface UpdateState {
  phase: UpdatePhase;
  dialogOpen: boolean;
  /** 本次运行内点过「稍后」的版本号；仅收起该版本在 available 态的顶栏胶囊。 */
  dismissedVersion: string | null;
}

export type TitlebarUpdatePill =
  | { kind: "available"; label: string }
  | { kind: "downloading"; label: string }
  | { kind: "downloaded"; label: string }
  | { kind: "ready"; label: string }
  | { kind: "error"; label: string };

export interface AccountMenuUpdateView {
  checking: boolean;
  badge: "accent" | "warn" | null;
  label: string;
  meta: string | null;
}

/** 顶栏右侧胶囊：无更新、自动检查中或已点「稍后」的 available 版本返回 null。 */
export function titlebarUpdatePill(state: UpdateState): TitlebarUpdatePill | null {
  const { phase, dismissedVersion } = state;
  switch (phase.kind) {
    case "available":
      if (dismissedVersion === phase.version) return null;
      return { kind: "available", label: `新版本 v${phase.version}` };
    case "downloading": {
      const pct = downloadPercent(phase.received, phase.total);
      const label =
        pct !== null
          ? `下载中 ${pct}%`
          : phase.received > 0
            ? `下载中 ${formatUpdateSize(phase.received)}`
            : "下载中…";
      return { kind: "downloading", label };
    }
    case "downloaded":
      return { kind: "downloaded", label: `重启以更新 v${phase.version}` };
    case "installing":
    case "ready":
      return { kind: "ready", label: "正在重启…" };
    case "error":
      if (phase.stage === "check") return null;
      return {
        kind: "error",
        label:
          phase.stage === "download"
            ? "更新下载失败"
            : phase.stage === "restart"
              ? "重启未完成"
              : "更新未完成",
      };
    default:
      return null;
  }
}

/** 侧栏左下角菜单的更新行与触发器圆点（即使顶栏胶囊点过「稍后」也保留入口提示）。 */
export function accountMenuUpdate(
  phase: UpdatePhase,
  appVersion: string,
): AccountMenuUpdateView {
  switch (phase.kind) {
    case "available":
      return {
        checking: false,
        badge: "accent",
        label: `新版本 v${phase.version}`,
        meta: null,
      };
    case "downloading": {
      const pct = downloadPercent(phase.received, phase.total);
      return {
        checking: false,
        badge: "accent",
        label: "正在下载更新…",
        meta: pct !== null ? `${pct}%` : null,
      };
    }
    case "downloaded":
      return {
        checking: false,
        badge: "accent",
        label: `重启以更新 v${phase.version}`,
        meta: null,
      };
    case "installing":
    case "ready":
      return {
        checking: false,
        badge: "accent",
        label: "正在重启…",
        meta: `v${phase.version}`,
      };
    case "error":
      if (phase.stage !== "check") {
        return {
          checking: false,
          badge: "warn",
          label:
            phase.stage === "download"
              ? "更新下载失败"
              : phase.stage === "restart"
                ? "重启未完成"
                : "更新未完成",
          meta: null,
        };
      }
      return {
        checking: false,
        badge: null,
        label: "检查更新",
        meta: `v${appVersion}`,
      };
    case "checking":
      return {
        checking: true,
        badge: null,
        label: "检查更新",
        meta: `v${appVersion}`,
      };
    default:
      return {
        checking: false,
        badge: null,
        label: "检查更新",
        meta: `v${appVersion}`,
      };
  }
}

const useUpdateStore = create<UpdateState>()(() => ({
  phase: { kind: "idle" },
  dialogOpen: false,
  dismissedVersion: null,
}));

function isLockedUpdate(phase: UpdatePhase): boolean {
  return (
    phase.kind === "downloading" ||
    phase.kind === "downloaded" ||
    phase.kind === "installing" ||
    phase.kind === "ready" ||
    (phase.kind === "error" && (phase.stage === "install" || phase.stage === "restart"))
  );
}

function hasActionableUpdate(phase: UpdatePhase): boolean {
  return (
    phase.kind === "available" ||
    isLockedUpdate(phase) ||
    (phase.kind === "error" && phase.stage === "download")
  );
}

function setPhase(phase: UpdatePhase) {
  useUpdateStore.setState({ phase });
}

export function openUpdateDialog() {
  useUpdateStore.setState({ dialogOpen: true });
}

/**
 * 侧栏菜单入口：
 * - 已有待处理的新版本、下载进度、待重启或下载/安装错误时，直接打开对话框；
 * - 其余状态发起手动检查并打开对话框。
 */
export function openOrCheckUpdates(runtime?: UpdaterRuntime): Promise<void> {
  const current = useUpdateStore.getState();
  if (hasActionableUpdate(current.phase)) {
    if (!current.dialogOpen) {
      useUpdateStore.setState({ dialogOpen: true });
    }
    return Promise.resolve();
  }
  return checkUpdates(true, runtime);
}

/**
 * 命令面板「检查更新」与错误态「重新检查」：
 * - 下载/安装进行中或已下载待重启时只打开对话框，不丢弃已下载好的安装包；
 * - 处于 available 或下载/安装错误态时，释放旧句柄并重新向远端拉取最新清单。
 */
export async function recheckUpdates(runtime?: UpdaterRuntime): Promise<void> {
  const current = useUpdateStore.getState();
  if (
    current.phase.kind === "downloading" ||
    current.phase.kind === "downloaded" ||
    current.phase.kind === "installing" ||
    current.phase.kind === "ready" ||
    (current.phase.kind === "error" && current.phase.stage === "restart")
  ) {
    if (!current.dialogOpen) {
      useUpdateStore.setState({ dialogOpen: true });
    }
    return;
  }
  if (current.phase.kind === "checking") {
    if (!current.dialogOpen) {
      useUpdateStore.setState({ dialogOpen: true });
    }
    return;
  }
  const discarded = await discardPendingUpdate();
  if (!discarded || useUpdateStore.getState().phase.kind === "checking") return;
  useUpdateStore.setState({ phase: { kind: "idle" } });
  await checkUpdates(true, runtime);
}

/**
 * 检查更新：
 * - 正在下载、已下载待重启、正在安装或安装/重启失败时绝不覆盖进度，也不重查远端；
 * - 手动检查立即打开对话框；自动检查全程静默，发现新版本后由顶栏胶囊与侧栏菜单提示。
 */
export async function checkUpdates(
  manual: boolean,
  runtime?: UpdaterRuntime,
): Promise<void> {
  const current = useUpdateStore.getState();
  if (isLockedUpdate(current.phase) || current.phase.kind === "checking") {
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
      if (isLockedUpdate(state.phase)) return state;
      if (
        !manual &&
        !state.dialogOpen &&
        (phase.kind === "unavailable" || (phase.kind === "error" && phase.stage === "check"))
      ) {
        return { ...state, phase: { kind: "idle" } };
      }
      return { ...state, phase };
    });
  }, runtime);
}

export function startDownload(runtime?: UpdaterRuntime): Promise<void> {
  const current = useUpdateStore.getState().phase;
  if (isLockedUpdate(current)) return Promise.resolve();
  return downloadUpdate(setPhase, runtime);
}

export function startInstall(runtime?: UpdaterRuntime): Promise<void> {
  const current = useUpdateStore.getState().phase;
  if (
    current.kind === "downloading" ||
    current.kind === "installing" ||
    current.kind === "ready" ||
    (current.kind === "error" && current.stage === "restart")
  ) {
    return Promise.resolve();
  }
  return installDownloadedUpdate(setPhase, runtime);
}

export function retryUpdate(runtime?: UpdaterRuntime): Promise<void> {
  const current = useUpdateStore.getState().phase;
  // 已经装好、只是重启没成功：重试只重启，不再下载。
  if (current.kind === "error" && current.stage === "restart") {
    return relaunchAfterUpdate(setPhase, current.version, runtime);
  }
  // 已经下好、安装步骤失败：直接重试安装，不再重下。
  if (current.kind === "error" && current.stage === "install" && hasDownloadedUpdate()) {
    return startInstall(runtime);
  }
  // 下载步骤失败：复用已有 Update 句柄直接重试下载，不再重查。
  if (
    current.kind === "error" &&
    (current.stage === "download" || current.stage === "install") &&
    hasPendingUpdate()
  ) {
    return startDownload(runtime);
  }
  return checkUpdates(true, runtime);
}

/** 在 available 态点击「稍后」：关闭弹窗并在本次运行内收起该版本的顶栏胶囊。 */
export function dismissUpdate() {
  useUpdateStore.setState((state) => ({
    dialogOpen: false,
    dismissedVersion:
      state.phase.kind === "available" ? state.phase.version : state.dismissedVersion,
  }));
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
  useUpdateStore.setState({
    phase: { kind: "idle" },
    dialogOpen: false,
    dismissedVersion: null,
  });
}
