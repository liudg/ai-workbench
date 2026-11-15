import { PanelLeft } from "lucide-react";

import { SIDEBAR_SHORTCUT_LABEL, toggleSidebar, useSidebarOpen } from "./sidebar-open";

export const SIDEBAR_TOGGLE_COPY = {
  hide: "隐藏侧边栏",
  show: "显示侧边栏",
} as const;

/** 窗口顶栏最左侧的无框侧栏开关，和 Ctrl+B 共用同一状态。 */
export function SidebarToggle() {
  const open = useSidebarOpen();
  const label = open ? SIDEBAR_TOGGLE_COPY.hide : SIDEBAR_TOGGLE_COPY.show;
  return (
    <button
      type="button"
      data-sidebar-toggle=""
      data-sidebar-toggle-state={open ? "open" : "closed"}
      aria-pressed={open}
      aria-keyshortcuts="Control+B"
      aria-label={`${label} ${SIDEBAR_SHORTCUT_LABEL}`}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
      onClick={() => toggleSidebar()}
    >
      <PanelLeft className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}
