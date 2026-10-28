import { chatImageSrc } from "@/lib/native/stage-image";

const pending = new Map<string, Promise<string>>();

/** 校验通过后，把本机路径换成 WebView 可加载的 asset URL。同一路径只请求一次。 */
export function resolveLocalChatImage(path: string): Promise<string> {
  const cached = pending.get(path);
  if (cached) return cached;

  const task = chatImageSrc(path);
  pending.set(path, task);
  task.catch(() => {
    pending.delete(path);
  });
  return task;
}
