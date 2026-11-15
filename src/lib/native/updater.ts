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
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "ready"; version: string } // 安装完成，待重启
  | { kind: "error"; stage: "check" | "install"; message: string }
  | { kind: "error"; stage: "restart"; version: string; message: string }; // 已装好，重启没成功

export interface UpdaterRuntime {
  isDesktop: boolean;
  endpoint: () => string | null;
  checkRemote: () => Promise<Update | null>;
  relaunchApp: () => Promise<void>;
}

/** 检查请求的上限；连接僵住时到点报错，不让界面一直停在检查中。 */
const CHECK_TIMEOUT_MS = 30_000;

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
let installing = false;

async function clearPending(): Promise<void> {
  const prev = pending;
  pending = null;
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

/** 检查远端是否有可用新版本。正在下载或安装时不重复发起。 */
export async function checkForUpdate(
  onPhase: (p: UpdatePhase) => void,
  runtime: UpdaterRuntime = defaultRuntime,
): Promise<void> {
  if (installing) return;
  if (!runtime.isDesktop || !runtime.endpoint()) {
    onPhase({ kind: "unavailable" });
    return;
  }
  onPhase({ kind: "checking" });
  try {
    const update = await runtime.checkRemote();
    await clearPending();
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
  }
}

/** 下载并安装已发现的更新，完成后重启应用。 */
export async function installUpdate(
  onPhase: (p: UpdatePhase) => void,
  runtime: UpdaterRuntime = defaultRuntime,
): Promise<void> {
  if (!runtime.isDesktop || !pending || installing) return;
  installing = true;
  const current = pending;
  const version = current.version;
  let received = 0;
  let total: number | null = null;
  onPhase({ kind: "downloading", received: 0, total: null });
  try {
    await current.downloadAndInstall((event) => {
      if (event.event === "Started") {
        received = 0;
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
      } else {
        return;
      }
      onPhase({ kind: "downloading", received, total });
    });
    await clearPending();
  } catch (e) {
    onPhase({
      kind: "error",
      stage: "install",
      message: formatUpdaterError(e, "install"),
    });
    return;
  } finally {
    installing = false;
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
  installing = false;
  await clearPending();
}
