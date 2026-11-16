import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SidebarToggle } from "@/shared/shell/SidebarToggle";
import type { WindowTitlebarState } from "./use-window-titlebar";

const DRAG_THRESHOLD_PX = 3;

export function WindowTitlebar({
  chrome,
  trailing,
}: {
  chrome: WindowTitlebarState;
  trailing?: ReactNode;
}) {
  const clearTrackRef = useRef<(() => void) | null>(null);

  useEffect(() => () => clearTrackRef.current?.(), []);

  const onMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (!chrome.nativeControls || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;

    clearTrackRef.current?.();
    if (event.detail === 2) {
      event.preventDefault();
      chrome.toggleMaximize();
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      clearTrackRef.current = null;
    };
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      if ((moveEvent.buttons & 1) === 0) {
        stop();
        return;
      }
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >= DRAG_THRESHOLD_PX) {
        stop();
        chrome.startDrag();
      }
    };
    clearTrackRef.current = stop;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
  };

  return (
    <header
      data-window-titlebar=""
      className={cn(
        "relative z-40 flex h-8 shrink-0 select-none items-center justify-between bg-wb-shell pl-3 text-xs text-wb-fg-3",
        chrome.nativeControls ? "pr-1" : "pr-3",
      )}
      onMouseDown={onMouseDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SidebarToggle />
        <span className="shrink-0 font-medium text-wb-fg-2">AI Workbench</span>
        {chrome.contextLabel ? (
          <>
            <span aria-hidden="true" className="shrink-0 text-wb-dim">
              /
            </span>
            <span
              data-window-context=""
              className="max-w-[14rem] truncate rounded bg-wb-hover px-1.5 py-0.5 text-xs text-wb-fg-2"
            >
              {chrome.contextLabel}
            </span>
          </>
        ) : null}
      </div>

      {trailing || chrome.nativeControls ? (
        <div className="flex shrink-0 items-center empty:hidden">
          {trailing}
          {chrome.nativeControls ? (
            <>
              <button
                type="button"
                data-window-action="minimize"
                aria-label="最小化"
                className="flex h-7 w-9 items-center justify-center rounded text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
                onClick={chrome.minimize}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M1.25 5h7.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                data-window-action="maximize"
                aria-label={chrome.maximized ? "向下还原" : "最大化"}
                className="flex h-7 w-9 items-center justify-center rounded text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
                onClick={chrome.toggleMaximize}
              >
                {chrome.maximized ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path
                      d="M3 2.2V1.5c0-.3.2-.5.5-.5H8.5c.3 0 .5.2.5.5v5c0 .3-.2.5-.5.5H7.8"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <rect x="1" y="2.8" width="6.2" height="6.2" rx="0.8" stroke="currentColor" strokeWidth="1" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <rect x="1.25" y="1.25" width="7.5" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.05" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                data-window-action="close"
                aria-label="关闭窗口"
                className="flex h-7 w-9 items-center justify-center rounded text-wb-fg-3 transition-colors hover:bg-red-500/80 hover:text-white"
                onClick={chrome.close}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M1.75 1.75l6.5 6.5M8.25 1.75l-6.5 6.5" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
                </svg>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
