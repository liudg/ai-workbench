import { backend } from "@/lib/ipc";
import type { AgentKind, Project, Session, SessionEvent } from "@/types";

export {
  clearMissingSessionBanner,
  deselectSession,
  isMissingSessionError,
  MISSING_SESSION,
  visibleBanner,
  withoutSession,
} from "./missing-session";

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

export async function loadWorkspaceLists(overrides: () => Record<string, AgentKind>): Promise<{
  projects: Project[];
  pairs: [string, Session[]][];
}> {
  const projects = await backend.listProjects();
  const pairs = await Promise.all(projects.map((project) => loadSessions(project.id, overrides)));
  return { projects, pairs };
}
