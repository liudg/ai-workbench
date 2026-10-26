// 粘贴或拖进来的图片先存进应用目录，再放进 WebView 能显示的范围。这是应用壳的事，网页预览没有。

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/daemon/endpoint";
import { fileToBase64 } from "@/shared/file-base64";
import type { Attachment } from "@/types";

export async function stageImage(file: File): Promise<Attachment> {
  if (!isTauri) throw new Error("粘贴图片只能在桌面版里用");
  const dataBase64 = await fileToBase64(file);
  return invoke<Attachment>("stage_chat_image", { dataBase64, name: file.name || "image.png" });
}
