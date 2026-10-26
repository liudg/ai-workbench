// 应用壳的本机能力：用系统程序打开文件，把文件放进内置浏览器能加载的地址。目录由调用方给出。

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/daemon/endpoint";

export interface BrowserFile {
  display: string;
  url: string;
}

const DESKTOP_ONLY = "只能在桌面版里打开";

export async function openPath(root: string, path: string, mode: "default" | "choose"): Promise<void> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  await invoke("open_path", { root, path, mode });
}

export async function prepareBrowserPath(root: string, path: string): Promise<BrowserFile> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  return invoke<BrowserFile>("prepare_browser_path", { root, path });
}
