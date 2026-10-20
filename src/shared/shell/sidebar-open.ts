import { useSyncExternalStore } from "react";

/** 侧栏开关和命令菜单共用的快捷键标签。 */
export const SIDEBAR_SHORTCUT_LABEL = "Ctrl+B" as const;

let open = true;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function isSidebarOpen(): boolean {
  return open;
}

export function setSidebarOpen(next: boolean) {
  if (open === next) return;
  open = next;
  emit();
}

export function toggleSidebar() {
  setSidebarOpen(!open);
}

export function useSidebarOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isSidebarOpen,
    () => true,
  );
}
