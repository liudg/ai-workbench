// 应用壳的内置浏览器：预览面板里的子 webview。只有桌面版有，调用方先判断 isTauri。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface BrowserNotice {
  kind: string;
  value: string;
}

export function browserShow(url: string, x: number, y: number, width: number, height: number) {
  return invoke<void>("browser_show", { url, x, y, width, height });
}

export function browserHide() {
  return invoke<void>("browser_hide");
}

export function browserReload() {
  return invoke<void>("browser_reload");
}

export function browserAnnotate(on: boolean) {
  return invoke<void>("browser_annotate", { on });
}

export function browserClose() {
  return invoke<void>("browser_close");
}

/** 页面标题、加载完成、批注开关和提交的批注。 */
export function onBrowserNotice(cb: (notice: BrowserNotice) => void): () => void {
  let unlisten: (() => void) | undefined;
  let stopped = false;
  void listen<BrowserNotice>("preview-browser", (e) => cb(e.payload)).then((stop) => {
    if (stopped) stop();
    else unlisten = stop;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
