// daemon 地址。桌面版问应用壳（顺便拉起 daemon）；网页预览由 vite 开发服务器读 daemon.json 给出。

import { invoke } from "@tauri-apps/api/core";

import type { DaemonEndpoint } from "./client";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** vite.config.ts 里的开发中间件提供。 */
export const DEV_ENDPOINT_PATH = "/__daemon/endpoint";

export async function resolveEndpoint(): Promise<DaemonEndpoint> {
  if (isTauri) return invoke<DaemonEndpoint>("daemon_endpoint");
  const response = await fetch(DEV_ENDPOINT_PATH);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as DaemonEndpoint;
}
