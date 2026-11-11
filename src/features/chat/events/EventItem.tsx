import { formatMessageTime } from "@/lib/utils";
import { isRenderedEventKind } from "./event-kinds";
import { eventRenderers } from "./registry";
import type { EventItemProps } from "./types";

export function EventItem({
  event,
  session,
  resolvedAnswer,
  showAgentLabel = true,
  showMessageFooter,
}: EventItemProps) {
  if (!isRenderedEventKind(event.kind)) return null;
  const Renderer = eventRenderers[event.kind];
  return (
    <Renderer
      event={event}
      session={session}
      resolvedAnswer={resolvedAnswer}
      time={formatMessageTime(event.ts)}
      showAgentLabel={showAgentLabel}
      showMessageFooter={showMessageFooter}
    />
  );
}
