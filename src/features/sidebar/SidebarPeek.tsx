import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 滑出动画结束再卸下，避免收起时侧栏继续挂在树上。 */
export const SIDEBAR_PEEK_MS = 160;

function hasOpenSidebarOverlay(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector("[data-fixed-menu], [role='dialog']:not([data-command-drill])"),
  );
}

/**
 * 侧栏收起后贴在窗口左缘。悬停时侧栏浮在内容上，不占布局；指针离开后收回。
 * 子树内弹出菜单或对话框时保持挂载，避免移向 Portal 浮层时把侧栏卸掉。
 */
export function SidebarPeek({ children }: { children: ReactNode }) {
  const [peek, setPeek] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const clearHide = useCallback(() => {
    if (hideTimer.current === null) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);

  const show = useCallback(() => {
    clearHide();
    setMounted(true);
    setPeek(true);
  }, [clearHide]);

  const scheduleHide = useCallback(() => {
    setPeek((current) => {
      if (!current) return current;
      return false;
    });
    clearHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setMounted(false);
    }, SIDEBAR_PEEK_MS);
  }, [clearHide]);

  const hide = useCallback(
    (event?: ReactMouseEvent<HTMLDivElement>) => {
      const nextTarget = event?.relatedTarget;
      if (
        nextTarget &&
        typeof Element !== "undefined" &&
        nextTarget instanceof Element &&
        nextTarget.closest("[data-fixed-menu], [role='dialog']")
      ) {
        return;
      }
      if (hasOpenSidebarOverlay()) return;
      scheduleHide();
    },
    [scheduleHide],
  );

  useEffect(() => {
    if (!peek || typeof MutationObserver === "undefined" || typeof document === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => {
      if (hasOpenSidebarOverlay()) return;
      if (rootRef.current?.matches?.(":hover")) return;
      scheduleHide();
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [peek, scheduleHide]);

  useEffect(() => clearHide, [clearHide]);

  return (
    <div
      ref={rootRef}
      data-sidebar-peek-root=""
      className={cn("fixed inset-y-0 left-0 z-30", peek ? "w-[260px]" : "w-2")}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <div data-sidebar-edge="" className="absolute inset-y-0 left-0 w-2" />
      {mounted ? (
        <div
          data-sidebar-peek={peek ? "open" : "closed"}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[260px] overflow-hidden rounded-r-2xl border-r border-[var(--wb-border-strong)] bg-[var(--wb-elev)] shadow-[var(--wb-float-shadow)]",
            peek ? "sidebar-peek-in" : "sidebar-peek-out",
          )}
        >
          {children}
        </div>
      ) : null}
      <span
        data-sidebar-accent=""
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-0.5 bg-[var(--wb-accent)]"
      />
    </div>
  );
}
