// 应用壳的本机能力：自定义无边框窗口的拖动、最小化、最大化/还原与关闭。

import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauri } from "@/lib/daemon/endpoint";

export const hasNativeWindowControls = isTauri;

export function minimizeNativeWindow(): void {
  if (!isTauri) return;
  void getCurrentWindow().minimize().catch(() => {});
}

export function toggleMaximizeNativeWindow(): void {
  if (!isTauri) return;
  void getCurrentWindow().toggleMaximize().catch(() => {});
}

export function closeNativeWindow(): void {
  if (!isTauri) return;
  void getCurrentWindow().close().catch(() => {});
}

export function startNativeWindowDrag(): void {
  if (!isTauri) return;
  void getCurrentWindow().startDragging().catch(() => {});
}

export function subscribeNativeWindowMaximized(onChange: (maximized: boolean) => void): () => void {
  if (!isTauri) return () => {};
  const win = getCurrentWindow();
  let disposed = false;
  let unlisten: (() => void) | null = null;

  const sync = () => {
    void win
      .isMaximized()
      .then((value) => {
        if (!disposed) onChange(value);
      })
      .catch(() => {});
  };

  sync();
  void win
    .onResized(() => {
      sync();
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});

  return () => {
    disposed = true;
    unlisten?.();
  };
}
