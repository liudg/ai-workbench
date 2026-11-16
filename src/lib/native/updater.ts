// 应用更新：收口对 Tauri updater 与 process 插件的调用。网页预览里没有更新源。

import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "../daemon/endpoint.ts";
import {
  configuredUpdateEndpoint,
  formatUpdaterError,
  updateFailureIsMissingSource,
} from "./update-source.ts";

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" } // 已是最新
  | { kind: "unavailable" }
  | { kind: "available"; version: string; notes: string }
  | {
      kind: "downloading";
      version: string;
      notes: string;
      received: number;
      total: number | null;
    }
  | { kind: "downloaded"; version: string; notes: string } // 已下载并验签，待安装重启
  | { kind: "installing"; version: string } // 正在拉起安装程序
  | { kind: "ready"; version: string } // 安装完成，正在重启
  | { kind: "error"; stage: "check" | "download" | "install"; message: string }
  | { kind: "error"; stage: "restart"; version: string; message: string }; // 已装好，重启没成功

export interface UpdaterRuntime {
  isDesktop: boolean;
  endpoint: () => string | null;
  checkRemote: () => Promise<Update | null>;
  relaunchApp: () => Promise<void>;
}

/** 检查请求的上限；连接僵住时到点报错，不让界面一直停在检查中。 */
const CHECK_TIMEOUT_MS = 30_000;
/** 下载更新包的总耗时上限；避免半开连接僵死导致永久锁在下载态，同时兼顾慢速网络。 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const PROGRESS_MIN_INTERVAL_MS = 100;
const PROGRESS_MIN_BYTES = 64 * 1024;

export const canCheckUpdates: boolean =
  isTauri && configuredUpdateEndpoint() !== null;

const defaultRuntime: UpdaterRuntime = {
  isDesktop: isTauri,
  endpoint: () => configuredUpdateEndpoint(),
  checkRemote: async () => {
    const { check } = await import("@tauri-apps/plugin-updater");
    return check({ timeout: CHECK_TIMEOUT_MS });
  },
  relaunchApp: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

let pending: Update | null = null;
let downloaded = false;
let busy = false;

async function clearPending(): Promise<void> {
  const prev = pending;
  pending = null;
  downloaded = false;
  if (prev) {
    try {
      await prev.close();
    } catch {
      // 句柄已释放时忽略
    }
  }
}

export function hasPendingUpdate(): boolean {
  return pending !== null;
}

export function hasDownloadedUpdate(): boolean {
  return pending !== null && downloaded;
}

/** 放弃当前未安装的更新句柄并释放底层资源（用于下载/安装报错后重新拉取远端）。 */
export async function discardPendingUpdate(): Promise<boolean> {
  if (busy) return false;
  await clearPending();
  return true;
}

/** 检查远端是否有可用新版本。正在检查、下载、已下载就绪或正在安装时不重复发起。 */
export async function checkForUpdate(
  onPhase: (p: UpdatePhase) => void,
  runtime: UpdaterRuntime = defaultRuntime,
): Promise<void> {
  if (busy || downloaded) return;
  if (!runtime.isDesktop || !runtime.endpoint()) {
    onPhase({ kind: "unavailable" });
    return;
  }
  busy = true;
  onPhase({ kind: "checking" });
  try {
    await clearPending();
    const update = await runtime.checkRemote();
    if (!update) {
      onPhase({ kind: "none" });
      return;
    }
    pending = update;
    onPhase({
      kind: "available",
      version: update.version,
      notes: update.body ?? "",
    });
  } catch (e) {
    const rawText = typeof e === "string" ? e : e instanceof Error ? e.message : "";
    if (updateFailureIsMissingSource(rawText)) {
      onPhase({ kind: "unavailable" });
      return;
    }
    onPhase({
      kind: "error",
      stage: "check",
      message: formatUpdaterError(e, "check"),
    });
  } finally {
    busy = false;
  }
}

/** 第 1 段：仅下载并验签更新包，不退出应用、不中断运行中会话。 */
export async function downloadUpdate(
  onPhase: (p: UpdatePhase) => void,
  runtime: UpdaterRuntime = defaultRuntime,
): Promise<void> {
  if (!runtime.isDesktop || !pending || busy) return;
  if (downloaded) {
    onPhase({
      kind: "downloaded",
      version: pending.version,
      notes: pending.body ?? "",
    });
    return;
  }
  busy = true;
  const current = pending;
  const version = current.version;
  const notes = current.body ?? "";
  let received = 0;
  let total: number | null = null;
  let lastPercent = -1;
  let lastBytes = 0;
  let lastEmitAt = 0;
  onPhase({ kind: "downloading", version, notes, received: 0, total: null });
  try {
    await current.download(
      (event) => {
        if (event.event === "Started") {
          received = 0;
          total = event.data.contentLength ?? null;
          lastPercent = 0;
          lastBytes = 0;
          lastEmitAt = Date.now();
          onPhase({ kind: "downloading", version, notes, received, total });
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          const now = Date.now();
          if (total && total > 0) {
            const pct = Math.min(100, Math.round((received / total) * 100));
            if (pct === lastPercent && now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS) {
              return;
            }
            lastPercent = pct;
          } else if (
            lastBytes > 0 &&
            received - lastBytes < PROGRESS_MIN_BYTES &&
            now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS
          ) {
            return;
          }
          lastBytes = received;
          lastEmitAt = now;
          onPhase({ kind: "downloading", version, notes, received, total });
        }
      },
      { timeout: DOWNLOAD_TIMEOUT_MS },
    );
    downloaded = true;
    onPhase({ kind: "downloaded", version, notes });
  } catch (e) {
    onPhase({
      kind: "error",
      stage: "download",
      message: formatUpdaterError(e, "download"),
    });
  } finally {
    busy = false;
  }
}

/** 第 2 段：安装已下载的更新包并重启应用。 */
export async function installDownloadedUpdate(
  onPhase: (p: UpdatePhase) => void,
  runtime: UpdaterRuntime = defaultRuntime,
): Promise<void> {
  if (!runtime.isDesktop || !pending || !downloaded || busy) return;
  busy = true;
  const current = pending;
  const version = current.version;
  onPhase({ kind: "installing", version });
  try {
    await current.install();
    await clearPending();
  } catch (e) {
    onPhase({
      kind: "error",
      stage: "install",
      message: formatUpdaterError(e, "install"),
    });
    return;
  } finally {
    busy = false;
  }
  await relaunchAfterUpdate(onPhase, version, runtime);
}

/** 新版本已装好后重启应用。重启没成功时只报重启失败，不回到下载。 */
export async function relaunchAfterUpdate(
  onPhase: (p: UpdatePhase) => void,
  version: string,
  runtime: UpdaterRuntime = defaultRuntime,
): Promise<void> {
  onPhase({ kind: "ready", version });
  try {
    await runtime.relaunchApp();
  } catch {
    onPhase({
      kind: "error",
      stage: "restart",
      version,
      message: `v${version} 已安装，自动重启没有成功，请重试或手动重启应用。`,
    });
  }
}

/** 仅供测试重置模块状态。 */
export async function resetUpdaterForTest(): Promise<void> {
  busy = false;
  await clearPending();
}
