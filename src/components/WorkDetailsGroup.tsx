import { ChevronRight, Wrench } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { EventItem } from "./EventItem";

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/**
 * 一段连续的工具调用折叠成一行摘要。
 * 会话运行中且位于时间线末尾时展开；最终答复到达后默认折叠。
 */
export function WorkDetailsGroup({
  events,
  session,
  live,
  expanded,
  onToggle,
}: {
  events: SessionEvent[];
  session: Session;
  live: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const count = events.length;
  const duration = formatDuration(events[count - 1].ts - events[0].ts);
  const label = live
    ? `正在工作… 已执行 ${count} 次工具调用`
    : `${count} 次工具调用${duration ? ` · 用时 ${duration}` : ""}`;

  return (
    <div className="event-in">
      <div className="px-6 py-1">
        <div className="mx-auto max-w-3xl">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="group flex w-full items-center gap-2 rounded py-0.5 text-left"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform duration-150",
                expanded && "rotate-90",
              )}
            />
            <Wrench
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                live ? "animate-pulse text-zinc-500" : "text-zinc-600",
              )}
            />
            <span className="text-xs text-zinc-500 group-hover:text-zinc-400">
              {label}
            </span>
          </button>
        </div>
      </div>
      {expanded
        ? events.map((event) => (
            <EventItem
              key={event.id}
              event={event}
              session={session}
              resolvedAnswer={null}
            />
          ))
        : null}
    </div>
  );
}
