import { formatMessageTime } from "@/lib/utils";
import { isRenderedEventKind } from "./event-kinds";
import { eventRenderers } from "./registry";
import type { EventItemProps } from "./types";

function noop() {}

export function EventItem({
  event,
  session,
  resolvedAnswer,
  thinkingOpen = false,
  onToggleThinking,
  showAgentLabel = true,
}: EventItemProps) {
  if (!isRenderedEventKind(event.kind)) return null;
  const Renderer = eventRenderers[event.kind];
  return (
    <Renderer
      event={event}
      session={session}
      resolvedAnswer={resolvedAnswer}
      time={formatMessageTime(event.ts)}
      thinkingOpen={thinkingOpen}
      onToggleThinking={onToggleThinking ?? noop}
      showAgentLabel={showAgentLabel}
    />
  );
}
