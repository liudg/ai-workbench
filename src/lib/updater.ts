// 应用更新：封装 tauri-plugin-updater。网页预览里没有更新源。

import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./daemon/endpoint";
import { configuredUpdateEndpoint, updateFailureIsMissingSource } from "./update-source";
import { userFacingMessage } from "./user-facing";

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" } // 已是最新
  | { kind: "unavailable" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "ready"; version: string } // 安装完成，待重启
  | { kind: "error"; message: string };

let pending: Update | null = null;

/** 检查更新。manual=false 时静默（失败不抛错、由调用方决定展示）。 */
export async function checkForUpdate(
  onPhase: (p: UpdatePhase) => void,
): Promise<void> {
  if (!isTauri || !configuredUpdateEndpoint()) {
    onPhase({ kind: "unavailable" });
    return;
  }
  onPhase({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
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
    const message = userFacingMessage(e) ?? "更新没有完成。";
    if (updateFailureIsMissingSource(message)) {
      onPhase({ kind: "unavailable" });
      return;
    }
    onPhase({ kind: "error", message });
  }
}

/** 下载并安装已发现的更新，完成后重启应用。 */
export async function installUpdate(
  onPhase: (p: UpdatePhase) => void,
): Promise<void> {
  if (!isTauri || !pending) return;
  const version = pending.version;
  let received = 0;
  let total: number | null = null;
  try {
    await pending.downloadAndInstall((event) => {
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
    pending = null;
    onPhase({ kind: "ready", version });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    onPhase({ kind: "error", message: userFacingMessage(e) ?? "更新没有完成。" });
  }
}
