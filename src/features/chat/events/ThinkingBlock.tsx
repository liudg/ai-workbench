import { ThinkingFold } from "./ThinkingFold";
import type { EventViewProps } from "./types";

export function ThinkingBlock({ event, thinkingOpen, onToggleThinking }: EventViewProps) {
  if (event.kind !== "thinking") return null;
  if (!event.text.trim()) return null;
  return <ThinkingFold text={event.text} open={thinkingOpen} onToggle={onToggleThinking} />;
}
