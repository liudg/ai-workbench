import type { SessionEvent } from "../../../types.ts";

export function collaborationMode(events: readonly SessionEvent[]): "plan" | "default" {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "collaboration-mode") {
      return event.mode === "plan" ? "plan" : "default";
    }
  }
  return "default";
}
