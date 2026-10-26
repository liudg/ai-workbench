// 侧栏底部一条几秒后自己消失的提示，比如「任务已删除」。

import { useSyncExternalStore } from "react";

let notice: string | null = null;
let timer: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function showSidebarNotice(text: string) {
  notice = text;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    notice = null;
    emit();
  }, 4000);
  emit();
}

export function useSidebarNotice(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notice,
  );
}
