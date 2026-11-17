import { ChevronDown, ChevronRight } from "lucide-react";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import { isPlaceholderThinking, thinkingSummary } from "./thinking-summary";
import type { EventViewProps } from "./types";

/** 思考条目保留在发生的位置：收起时露出一行摘要，展开后显示适配器提供的正文。 */
export function ThinkingBlock({
  event,
  thinkingOpen,
  thinkingActive = false,
  onToggleThinking,
}: EventViewProps) {
  if (event.kind !== "thinking" || !event.text.trim()) return null;
  const label = thinkingActive ? DESKTOP_ZH.liveThinking : DESKTOP_ZH.thinkingLabel;
  if (isPlaceholderThinking(event.text)) {
    return (
      <div className="event-in min-w-0 px-6 py-1" data-thinking={event.id}>
        <div className="min-w-0 pl-6">
          <span className="inline-flex items-center text-[13px] text-wb-fg-3">{label}</span>
        </div>
      </div>
    );
  }
  const open = thinkingOpen;
  const Chevron = open ? ChevronDown : ChevronRight;
  const summary = open ? "" : thinkingSummary(event.text);
  return (
    <div
      className="event-in min-w-0 px-6 py-1"
      data-thinking={event.id}
      data-thinking-active={thinkingActive ? "true" : undefined}
    >
      <div className="min-w-0 pl-6">
        <button
          type="button"
          className="flex max-w-full min-w-0 items-center gap-1.5 rounded text-[13px] text-wb-fg-2 hover:text-wb-fg"
          aria-expanded={open}
          aria-controls={`thinking-${event.id}`}
          onClick={onToggleThinking}
        >
          <span className="shrink-0">{label}</span>
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
        {open ? (
          <div
            id={`thinking-${event.id}`}
            className="mt-2 min-w-0 border-l border-wb-border pl-3 text-sm text-wb-fg-2"
          >
            <AssistantAnswer text={event.text} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
