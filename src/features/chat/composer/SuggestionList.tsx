import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 作曲栏上方的候选列表外壳：贴着输入框上沿、等宽，限高滚动，方向键选中的项始终在视野里。 */
export function SuggestionList({
  label,
  active,
  className,
  footer,
  children,
  ...rest
}: {
  label: string;
  /** 当前选中项的下标，变化时把它滚进视野。 */
  active: number;
  /** 固定在列表下方、不随列表滚动的说明。 */
  footer?: ReactNode;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "role" | "aria-label" | "children">) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!list || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [active]);
  return (
    <div
      className={cn(
        "wb-popover absolute bottom-full left-0 right-0 z-20 mb-2 min-w-0 overflow-hidden rounded-xl",
        className,
      )}
      {...rest}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        className="relative max-h-72 overflow-x-hidden overflow-y-auto overscroll-contain py-1"
      >
        {children}
      </div>
      {footer}
    </div>
  );
}
