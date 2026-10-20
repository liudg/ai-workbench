import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 黑底白字胶囊。快捷键放在灰底小 pill 里。 */
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
  const text = shortcut ? `${label} ${shortcut}` : label;
  return (
    <span className="group/hint relative inline-flex" title={text}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute top-full z-50 mt-1 hidden items-center gap-1.5 whitespace-nowrap rounded-full bg-zinc-950 px-2 py-1 text-[11px] text-white shadow-lg group-hover/hint:flex",
          align === "end" ? "right-0" : align === "start" ? "left-0" : "left-1/2 -translate-x-1/2",
        )}
      >
        <span>{label}</span>
        {shortcut ? (
          <kbd className="rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-100">{shortcut}</kbd>
        ) : null}
      </span>
    </span>
  );
}
