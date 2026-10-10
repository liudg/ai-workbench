import { backend } from "@/lib/ipc";
import { isReadOnlyOpen } from "@/lib/utils";
import type { AgentKind, Session, SessionEvent } from "@/types";

export const MISSING_SESSION = "会话不存在或已结束";

export function clearMissingSessionBanner(
  lastError: string | null,
  events: { kind: string }[],
): string | null {
  if (lastError === MISSING_SESSION && isReadOnlyOpen(events)) return null;
  return lastError;
}

export function mergeEvents(
  local: SessionEvent[] | undefined,
  remote: SessionEvent[],
): SessionEvent[] {
  const map = new Map<string, SessionEvent>();
  for (const event of remote) map.set(event.id, event);
  for (const event of local ?? []) map.set(event.id, event);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export function stampAgents(
  list: Session[],
  overrides: Record<string, AgentKind>,
): Session[] {
  return list.map((session) =>
    overrides[session.id] ? { ...session, agent: overrides[session.id] } : session,
  );
}

export async function loadSessions(
  projectId: string,
  overrides: () => Record<string, AgentKind>,
): Promise<[string, Session[]]> {
  const list = await backend.listSessions(projectId);
  return [projectId, stampAgents(list, overrides())];
}
