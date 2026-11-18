import { ChevronDown, ChevronRight } from "lucide-react";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import { hasThinkingBody, thinkingSummary } from "./thinking-summary";
import type { EventViewProps } from "./types";

/** 思考条目保留在发生的位置：收起时露出一行摘要，展开后显示适配器提供的正文。只有占位词时不占位。 */
export function ThinkingBlock({ event, thinkingOpen, onToggleThinking }: EventViewProps) {
  if (event.kind !== "thinking" || !hasThinkingBody(event.text)) return null;
  const Chevron = thinkingOpen ? ChevronDown : ChevronRight;
  const summary = thinkingOpen ? "" : thinkingSummary(event.text);
  return (
    <div className="event-in min-w-0 px-6 py-1" data-thinking={event.id}>
      <div className="min-w-0 pl-6">
        <button
          type="button"
          className="flex max-w-full min-w-0 items-center gap-1.5 rounded text-[13px] text-wb-fg-2 hover:text-wb-fg"
          aria-expanded={thinkingOpen}
          aria-controls={`thinking-${event.id}`}
          onClick={onToggleThinking}
        >
          <span className="shrink-0">{DESKTOP_ZH.thinkingLabel}</span>
          {summary ? (
            <>
              <span aria-hidden="true" className="shrink-0 text-wb-fg-3">
                ·
              </span>
              <span data-thinking-summary className="min-w-0 truncate text-wb-fg-3">
                {summary}
              </span>
            </>
          ) : null}
          <Chevron className="h-3.5 w-3.5 shrink-0" />
        </button>
        {thinkingOpen ? (
          <div
            id={`thinking-${event.id}`}
            className="mt-1.5 min-w-0 border-l border-wb-border pl-3 text-[13px] text-wb-fg-2"
          >
            <AssistantAnswer text={event.text} variant="thinking" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
