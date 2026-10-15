import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 一轮的状态行：`Agent · 用时 …` 或 `Agent · 运行中`。
 * 图标来自这一条会话的适配器资料。
 */
export function TurnFoldLine({
  summary,
  expanded,
  onToggle,
  icon,
  pulse = false,
}: {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  icon?: ReactNode;
  pulse?: boolean;
}) {
  return (
    <div className="event-in min-w-0 px-6 py-1">
      <button
        type="button"
        data-turn-fold
        data-turn-summary={summary}
        data-expanded={expanded ? "true" : "false"}
        aria-expanded={expanded}
        title={summary}
        onClick={onToggle}
        className="group inline-flex max-w-full min-w-0 flex-nowrap items-center gap-2 rounded py-0.5 text-left"
      >
        {icon}
        <span className="min-w-0 truncate text-[12.5px] text-[#8a8a8a] group-hover:text-[#bdbdbd]">
          {summary}
        </span>
        {pulse ? (
          <span data-turn-running className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#4f8dff]" />
        ) : null}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-[#555] transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
      </button>
    </div>
  );
}
