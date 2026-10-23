// 选一个本机文件夹。桌面版用系统对话框；网页预览没有，让用户输入路径。

import { open } from "@tauri-apps/plugin-dialog";

import { isTauri } from "@/lib/daemon/endpoint";

export async function pickFolder(title: string): Promise<string | null> {
  if (isTauri) {
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : null;
  }
  const typed = window.prompt(`${title}\n输入本机绝对路径：`)?.trim();
  return typed ? typed : null;
}
