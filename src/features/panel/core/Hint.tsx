import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 悬停提示胶囊。快捷键放在微描边小 pill 里。 */
export function Hint({
  label,
  shortcut,
  align = "center",
  children,
}: {
  label: string;
  shortcut?: string;
  align?: "start" | "center" | "end";
  children: ReactNode;
}) {
  return (
    <span className="group/hint relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          "wb-tooltip pointer-events-none absolute top-full z-50 mt-1.5 hidden items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-[11px] group-hover/hint:flex group-focus-within/hint:flex",
          align === "end" ? "right-0" : align === "start" ? "left-0" : "left-1/2 -translate-x-1/2",
        )}
      >
        <span>{label}</span>
        {shortcut ? (
          <kbd className="rounded border border-wb-border bg-wb-elev px-1 py-0.5 text-[10px] text-wb-fg-2">
            {shortcut}
          </kbd>
        ) : null}
      </span>
    </span>
  );
}
