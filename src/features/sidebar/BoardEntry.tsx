import { SquareKanban } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBoardEntry } from "./use-board-entry";

/** 侧栏顶部的看板入口，带上需要处理的会话数。 */
export function BoardEntry() {
  const { open, count, toggle } = useBoardEntry();
  return (
    <div className="px-2.5 pt-1">
      <button
        type="button"
        data-board-entry=""
        aria-pressed={open}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors",
          open
            ? "bg-wb-active font-medium text-wb-fg"
            : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
        )}
        onClick={toggle}
      >
        <SquareKanban className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" />
        <span className="flex-1">看板</span>
        {count > 0 && (
          <span
            title={`${count} 个会话待处理`}
            className="rounded-full bg-wb-warn-soft px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums text-wb-warn"
          >
            {count} 待处理
          </span>
        )}
      </button>
    </div>
  );
}
