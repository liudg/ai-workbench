// 选本机文件。桌面版用系统对话框；网页预览没有，让用户输入路径。

import { open } from "@tauri-apps/plugin-dialog";

import { isTauri } from "@/lib/daemon/endpoint";
import { baseName } from "@/shared/path";
import type { Attachment } from "@/types";

export async function pickFiles(title: string): Promise<Attachment[]> {
  let paths: string[];
  if (isTauri) {
    const selected = await open({ multiple: true, directory: false, title });
    paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
  } else {
    const typed = window.prompt(`${title}\n输入本机绝对路径：`)?.trim();
    paths = typed ? [typed] : [];
  }
  return paths.map((path) => ({ path, name: baseName(path) }));
}
