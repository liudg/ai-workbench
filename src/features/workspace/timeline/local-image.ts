import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/ipc";

const pending = new Map<string, Promise<string>>();

/** 校验通过后，把本机路径换成 WebView 可加载的 asset URL。同一路径只请求一次。 */
export function resolveLocalChatImage(path: string): Promise<string> {
  if (!isTauri) {
    return Promise.reject(new Error("本地图片只能在桌面版预览"));
  }
  const cached = pending.get(path);
  if (cached) return cached;

  const task = invoke<string>("prepare_chat_image", { path }).then((allowed) =>
    convertFileSrc(allowed),
  );
  pending.set(path, task);
  task.catch(() => {
    pending.delete(path);
  });
  return task;
}
