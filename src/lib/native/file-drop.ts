// 从系统拖进窗口的文件。桌面版由应用壳接管拖放，带真实路径和光标位置；网页预览收不到。

import { getCurrentWebview } from "@tauri-apps/api/webview";

import { isTauri } from "@/lib/daemon/endpoint";

/** 位置是相对窗口内容左上角的 CSS 像素。 */
export type FileDrop =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; x: number; y: number; paths: string[] }
  | { type: "leave" };

export function listenFileDrop(handler: (drop: FileDrop) => void): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        handler({ type: "leave" });
        return;
      }
      const scale = window.devicePixelRatio || 1;
      const x = payload.position.x / scale;
      const y = payload.position.y / scale;
      if (payload.type === "drop") handler({ type: "drop", x, y, paths: payload.paths });
      else handler({ type: "over", x, y });
    })
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
