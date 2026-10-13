import type { QueuedTurn, SessionEvent } from "@/types";
import { subscribe } from "./call";
import type { Backend } from "./contract";
import type { SessionRequest } from "./dto";

export const eventCommands: Pick<
  Backend,
  | "onSessionEvent"
  | "onSessionQueue"
  | "onSessionsChanged"
  | "onProjectsChanged"
  | "onSessionRequest"
> = {
  onSessionEvent: (cb) => subscribe<SessionEvent>("session-event", cb),
  onSessionQueue: (cb) =>
    subscribe<{ session_id: string; items: QueuedTurn[] }>(
      "session-queue",
      cb,
    ),
  onSessionsChanged: (cb) =>
    subscribe<{ project_id: string }>("sessions-changed", (p) =>
      cb(p.project_id),
    ),
  onProjectsChanged: (cb) => subscribe("projects-changed", () => cb()),
  onSessionRequest: (cb) => subscribe<SessionRequest>("session-request", cb),
};
