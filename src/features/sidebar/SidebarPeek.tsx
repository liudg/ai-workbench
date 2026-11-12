import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 滑出动画结束再卸下，避免收起时侧栏继续挂在树上。 */
export const SIDEBAR_PEEK_MS = 160;

/**
 * 侧栏收起后贴在窗口左缘。悬停时侧栏浮在内容上，不占布局；指针离开后收回。
 * 点开会话不会收起。固定展开走侧栏开关，不走这里。
 */
export function SidebarPeek({ children }: { children: ReactNode }) {
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
      className={cn("fixed inset-y-0 left-0 z-30", peek ? "w-[256px]" : "w-2")}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <div data-sidebar-edge="" className="absolute inset-y-0 left-0 w-2" />
      {mounted ? (
        <div
          data-sidebar-peek={peek ? "open" : "closed"}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[256px] border-r border-wb-border shadow-[var(--wb-popover-shadow)]",
            peek ? "sidebar-peek-in" : "sidebar-peek-out",
          )}
        >
          {children}
        </div>
      ) : null}
      <span
        data-sidebar-accent=""
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-0.5 bg-wb-accent"
      />
    </div>
  );
}
