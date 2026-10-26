// 主区顶部的一条错误提示。操作失败又没有自己的位置显示时用它，和 v1 的 lastError 横幅一样。

import { useSyncExternalStore } from "react";

import { userFacingMessage } from "@/lib/user-facing";

let current: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** 只显示给人看的短句；看不懂的原文不显示。 */
export function showError(error: unknown) {
  const text = userFacingMessage(error);
  if (!text || text === current) return;
  current = text;
  emit();
}

export function clearError() {
  if (current === null) return;
  current = null;
  emit();
}

export function useErrorBanner(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
