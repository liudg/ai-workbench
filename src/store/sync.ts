import { backend } from "@/lib/ipc";
import type { Project, Session } from "@/types";

export {
  clearMissingSessionBanner,
  deselectSession,
  isMissingSessionError,
  MISSING_SESSION,
  visibleBanner,
  withoutSession,
} from "./missing-session";

export { mergeEvents } from "./event-log";

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
