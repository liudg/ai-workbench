import { Bot, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 一轮的状态行：`Agent · 用时 …` 或 `Agent · 正在处理…`。
 * 箭头在右侧，和已结束回合的折叠行同一套。
 */
export function TurnFoldLine({
  summary,
  expanded,
  onToggle,
  showAgentIcon,
  pulse = false,
}: {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  showAgentIcon: boolean;
  pulse?: boolean;
}) {
  return (
    <div className="event-in min-w-0 px-6 py-1">
      <div className="mx-auto min-w-0 max-w-3xl">
        <button
          type="button"
          data-turn-fold
          data-turn-summary={summary}
          data-expanded={expanded ? "true" : "false"}
          aria-expanded={expanded}
          title={summary}
          onClick={onToggle}
          className="group flex w-full min-w-0 flex-nowrap items-center gap-2 rounded py-0.5 text-left"
        >
          {showAgentIcon ? (
            <Bot
              className={cn("h-3.5 w-3.5 shrink-0 text-zinc-500", pulse && "animate-pulse")}
            />
          ) : null}
          <span className="min-w-0 truncate text-xs text-zinc-500 group-hover:text-zinc-400">
            {summary}
          </span>
          <ChevronRight
            className={cn(
              "ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
        </button>
      </div>
    </div>
  );
}
