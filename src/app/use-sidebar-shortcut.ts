import { useEffect } from "react";

import { isSidebarChord } from "@/features/command-menu/keyboard";
import { toggleSidebar } from "@/shared/shell/sidebar-open";

/** Ctrl+B 开关侧栏。捕获阶段，输入框聚焦时也能接到。 */
export function useSidebarShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSidebarChord(event)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
