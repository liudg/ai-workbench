import { backend } from "@/lib/ipc";
import type { Project, Session, SessionEvent } from "@/types";

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

export async function loadSessions(projectId: string): Promise<[string, Session[]]> {
  const list = await backend.listSessions(projectId);
  return [projectId, list];
}

export async function loadWorkspaceLists(): Promise<{
  projects: Project[];
  pairs: [string, Session[]][];
}> {
  const projects = await backend.listProjects();
  const pairs = await Promise.all(projects.map((project) => loadSessions(project.id)));
  return { projects, pairs };
}
