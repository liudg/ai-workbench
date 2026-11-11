import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

export interface TooltipProps {
  label: string;
  shortcut?: string;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
}

const VIEWPORT_MARGIN = 8;
const GAP = 6;

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 统一浮层提示组件：
 * - 通过 Portal 挂到 `document.body`，避免被 `overflow-x-auto` / `overflow-hidden` 容器裁切；
 * - 不挂原生 `title`，避免系统默认黄/黑框与自定义胶囊重叠；
 * - 始终保留 `sr-only` 语义节点，兼顾屏幕阅读器与静态渲染测试。
 */
export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  align = "center",
  className,
  children,
}: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
    opacity: 0,
  });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble || typeof window === "undefined") return;

    const triggerRect = anchor.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;

    let resolvedSide = side;
    if (
      side === "bottom" &&
      triggerRect.bottom + GAP + bubbleRect.height > vh - VIEWPORT_MARGIN &&
      triggerRect.top - GAP - bubbleRect.height >= VIEWPORT_MARGIN
    ) {
      resolvedSide = "top";
    } else if (
      side === "top" &&
      triggerRect.top - GAP - bubbleRect.height < VIEWPORT_MARGIN &&
      triggerRect.bottom + GAP + bubbleRect.height <= vh - VIEWPORT_MARGIN
    ) {
      resolvedSide = "bottom";
    }

    const top =
      resolvedSide === "top"
        ? Math.max(VIEWPORT_MARGIN, triggerRect.top - GAP - bubbleRect.height)
        : Math.min(vh - VIEWPORT_MARGIN - bubbleRect.height, triggerRect.bottom + GAP);

    let left =
      align === "start"
        ? triggerRect.left
        : align === "end"
          ? triggerRect.right - bubbleRect.width
          : triggerRect.left + triggerRect.width / 2 - bubbleRect.width / 2;

    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(vw - VIEWPORT_MARGIN - bubbleRect.width, left),
    );

    setStyle({
      position: "fixed",
      top: Math.round(top),
      left: Math.round(left),
      opacity: 1,
    });
  }, [align, side]);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const dismiss = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, updatePosition]);

  const alignClass =
    align === "end" ? "right-0" : align === "start" ? "left-0" : "left-1/2 -translate-x-1/2";

  const canPortal = open && typeof document !== "undefined" && Boolean(document.body);

  return (
    <span
      ref={anchorRef}
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onPointerDown={() => setOpen(false)}
      onFocus={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.matches?.(":focus-visible")) {
          setOpen(true);
        }
      }}
      onBlur={() => setOpen(false)}
    >
      {children}
      <span
        role={canPortal ? undefined : "tooltip"}
        aria-hidden={canPortal ? true : undefined}
        className={cn("sr-only", alignClass)}
      >
        <span>{label}</span>
        {shortcut ? <kbd>{shortcut}</kbd> : null}
      </span>
      {canPortal
        ? createPortal(
            <span
              ref={bubbleRef}
              role="tooltip"
              style={style}
              className="pointer-events-none z-[90] inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--wb-text-strong)] shadow-[var(--wb-float-shadow)] transition-opacity duration-100"
            >
              <span>{label}</span>
              {shortcut ? (
                <kbd className="rounded border border-[var(--wb-border)] bg-[var(--wb-chip)] px-1 py-0.5 font-mono text-[10px] font-normal text-[var(--wb-muted)]">
                  {shortcut}
                </kbd>
              ) : null}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
