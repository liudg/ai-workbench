// 选本机文件。桌面版用系统对话框；网页预览没有，让用户输入路径。

import { open } from "@tauri-apps/plugin-dialog";

import { isTauri } from "@/lib/daemon/endpoint";
import { baseName } from "@/shared/path";
import type { Attachment } from "@/types";

async function pickPaths(title: string, multiple: boolean): Promise<string[]> {
  if (isTauri) {
    const selected = await open({ multiple, directory: false, title });
    return Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
  }
  const typed = window.prompt(`${title}\n输入本机绝对路径：`)?.trim();
  return typed ? [typed] : [];
}

export async function pickFiles(title: string): Promise<Attachment[]> {
  return (await pickPaths(title, true)).map((path) => ({ path, name: baseName(path) }));
}

/** 选一个文件。取消时返回 null。 */
export async function pickFile(title: string): Promise<string | null> {
  return (await pickPaths(title, false))[0] ?? null;
}
