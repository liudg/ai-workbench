import { Brain, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { CopyButton } from "./chrome";
import type { EventViewProps } from "./types";

export function ThinkingBlock({ event, time, thinkingOpen, onToggleThinking }: EventViewProps) {
  if (event.kind !== "thinking") return null;
  const text = event.text;
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="min-w-0">
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <button type="button" aria-expanded={thinkingOpen} onClick={onToggleThinking} className="flex items-center gap-2 text-left">
            <ChevronRight
              className={cn("h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform", thinkingOpen && "rotate-90")}
            />
            <Brain className="h-3.5 w-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-500">思考</span>
          </button>
          <span className="text-[11px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100">{time}</span>
          <CopyButton
            text={text}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </div>
        {thinkingOpen ? (
          <p className="min-w-0 break-words whitespace-pre-wrap pl-6 text-sm leading-6 text-zinc-400">{text}</p>
        ) : null}
      </div>
    </div>
  );
}
