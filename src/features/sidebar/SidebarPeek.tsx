import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { setSidebarOpen } from "@/shared/shell/sidebar-open";

/** 滑出动画结束再卸下，避免收起时侧栏继续挂在树上。 */
export const SIDEBAR_PEEK_MS = 160;

/**
 * 侧栏收起后贴在窗口左缘。悬停时侧栏浮在内容上，不占布局；指针离开后收回；点击左缘热区固定展开。
 */
export function SidebarPeek({
  children,
  needsYou = false,
}: {
  children: ReactNode;
  needsYou?: boolean;
}) {
  const [peek, setPeek] = useState(false);
  const [mounted, setMounted] = useState(false);
  const hideTimer = useRef<number | null>(null);

  const clearHide = () => {
    if (hideTimer.current === null) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const show = () => {
    clearHide();
    setMounted(true);
    setPeek(true);
  };

  const hide = () => {
    setPeek((current) => {
      if (!current) return current;
      return false;
    });
    clearHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setMounted(false);
    }, SIDEBAR_PEEK_MS);
  };

  useEffect(() => clearHide, []);

  return (
    <div
      data-sidebar-peek-root=""
      className={cn(
        "group/peek fixed bottom-0 left-0 top-[var(--wb-shell-top,0px)] z-30",
        peek ? "w-[244px]" : "w-2",
      )}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <div
        data-sidebar-edge=""
        className="absolute inset-y-0 left-0 w-2 cursor-pointer"
        onClick={() => setSidebarOpen(true)}
      />
      {mounted ? (
        <div
          data-sidebar-peek={peek ? "open" : "closed"}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[244px] border-r border-wb-border shadow-[var(--wb-popover-shadow)]",
            peek ? "sidebar-peek-in" : "sidebar-peek-out",
          )}
        >
          {children}
        </div>
      ) : null}
      {!peek ? (
        <span
          data-sidebar-edge-line=""
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-px bg-wb-border-strong opacity-40 transition-opacity group-hover/peek:opacity-100"
        />
      ) : null}
      {needsYou && !peek ? (
        <span
          data-sidebar-alert=""
          className="pointer-events-none absolute left-0.5 top-16 z-10 h-9 w-1 rounded-full bg-wb-warn shadow-[0_0_10px_var(--color-wb-warn-soft)] transition-all group-hover/peek:h-12"
        />
      ) : null}
    </div>
  );
}
