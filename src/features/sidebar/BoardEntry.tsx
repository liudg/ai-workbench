import { SquareKanban } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBoardEntry } from "./use-board-entry";

/** 侧栏顶上的看板入口，带上等着你的会话数。 */
export function BoardEntry() {
  const { open, count, toggle } = useBoardEntry();
  return (
    <div className="px-2 pt-1">
      <button
        type="button"
        data-board-entry=""
        aria-pressed={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]",
          open ? "bg-[#222] text-[#f3f3f3]" : "text-[#cfcfcf] hover:bg-white/[0.04]",
        )}
        onClick={toggle}
      >
        <SquareKanban className="h-3.5 w-3.5 shrink-0 text-[#8a8a8a]" />
        <span className="flex-1">看板</span>
        {count > 0 && (
          <span
            title={`${count} 个会话等着你`}
            className="rounded-full bg-[#f0a04a]/15 px-1.5 text-[10.5px] leading-4 tabular-nums text-[#f0a04a]"
          >
            {count}
          </span>
        )}
      </button>
    </div>
  );
}
