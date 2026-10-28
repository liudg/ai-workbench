// 时间线和作曲栏的本机图片：放进 WebView 能显示的范围。这是应用壳的事，网页预览没有。

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/daemon/endpoint";
import { fileToBase64 } from "@/shared/file-base64";
import type { Attachment } from "@/types";

/** 粘贴或拖进来的图片先存进应用目录。 */
export async function stageImage(file: File): Promise<Attachment> {
  if (!isTauri) throw new Error("粘贴图片只能在桌面版里用");
  const dataBase64 = await fileToBase64(file);
  return invoke<Attachment>("stage_chat_image", { dataBase64, name: file.name || "image.png" });
}

/** 校验是本机图片后，换成 WebView 能加载的地址。 */
export async function chatImageSrc(path: string): Promise<string> {
  if (!isTauri) throw new Error("本地图片只能在桌面版预览");
  return convertFileSrc(await invoke<string>("prepare_chat_image", { path }));
}
