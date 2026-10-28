// 应用壳的本机能力：用系统程序打开文件或目录，把文件放进内置浏览器能加载的地址。目录由调用方给出。

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

/** 在系统资源管理器里打开目录。 */
export async function revealFolder(path: string): Promise<void> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  await invoke("reveal_folder", { path });
}

/** 这个系统能不能在「打开」里选择应用。 */
export async function canChooseApp(): Promise<boolean> {
  if (!isTauri) return false;
  const caps = await invoke<{ choose_app: boolean }>("file_open_capabilities");
  return Boolean(caps.choose_app);
}

export async function prepareBrowserPath(root: string, path: string): Promise<BrowserFile> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  return invoke<BrowserFile>("prepare_browser_path", { root, path });
}
