import type { Project, Session } from "@/types";
import { draftId, type DraftCarryState } from "./draft-session.ts";
import { STANDALONE_DRAFT_ID } from "./standalone-id.ts";
import type { SessionDraft } from "./types";

export { STANDALONE_DRAFT_ID, STANDALONE_DRAFT_TITLE, isStandaloneDraft } from "./standalone-id.ts";

export function visibleProjects(projects: readonly Project[]): Project[] {
  return projects.filter((project) => !project.standalone);
}

export function standaloneChatSessions(
  projects: readonly Project[],
  sessions: Readonly<Record<string, readonly Session[] | undefined>>,
): Session[] {
  const rows: Session[] = [];
  for (const project of projects) {
    if (!project.standalone) continue;
    for (const session of sessions[project.id] ?? []) rows.push(session);
  }
  rows.sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at);
  return rows;
}

export function keepSelectedProjectId(input: {
  projects: readonly Pick<Project, "id" | "standalone">[];
  current: string | null;
  standaloneDraftFocused: boolean;
}): string | null {
  if (input.standaloneDraftFocused) return STANDALONE_DRAFT_ID;
  if (input.current && input.projects.some((project) => project.id === input.current)) {
    return input.current;
  }
  return input.projects.find((project) => !project.standalone)?.id ?? null;
}

export function projectStillListed(projectId: string, ids: ReadonlySet<string>): boolean {
  return projectId === STANDALONE_DRAFT_ID || ids.has(projectId);
}

export function standaloneDraftProject(draft: SessionDraft): Project {
  return {
    id: STANDALONE_DRAFT_ID,
    name: "聊天",
    path: "",
    default_agent: draft.agent,
    created_at: 0,
    updated_at: 0,
    standalone: true,
  };
}

function moveDraftKey<T>(map: Record<string, T>, fromKey: string, toKey: string): Record<string, T> {
  if (!(fromKey in map) && !(toKey in map)) return map;
  const next = { ...map };
  if (fromKey in next) {
    next[toKey] = next[fromKey] as T;
    delete next[fromKey];
  } else {
    delete next[toKey];
  }
  return next;
}

/** 独立草稿还没建目录。选中项目后，这段草稿改到那个项目里。 */
export function retargetStandaloneDraft(
  state: DraftCarryState,
  targetProjectId: string,
): DraftCarryState | null {
  if (!targetProjectId || targetProjectId === STANDALONE_DRAFT_ID) return null;
  const draft = state.drafts[STANDALONE_DRAFT_ID];
  if (!draft || draft.phase === "creating") return null;
  if (state.drafts[targetProjectId]?.phase === "creating") return null;
  const fromKey = draftId(STANDALONE_DRAFT_ID);
  const toKey = draftId(targetProjectId);
  const drafts = { ...state.drafts, [targetProjectId]: { ...draft, projectId: targetProjectId } };
  delete drafts[STANDALONE_DRAFT_ID];
  const draftFocused = { ...state.draftFocused, [targetProjectId]: true };
  delete draftFocused[STANDALONE_DRAFT_ID];
  const activeSessionId = { ...state.activeSessionId };
  delete activeSessionId[STANDALONE_DRAFT_ID];
  delete activeSessionId[targetProjectId];
  return {
    ...state,
    drafts,
    draftFocused,
    activeSessionId,
    selectedProjectId: targetProjectId,
    preferredAgent: draft.agent,
    attachments: moveDraftKey(state.attachments, fromKey, toKey),
    textSnippets: moveDraftKey(state.textSnippets, fromKey, toKey),
    sandboxes: moveDraftKey(state.sandboxes, fromKey, toKey),
    tuning: moveDraftKey(state.tuning, fromKey, toKey),
    accessMode: moveDraftKey(state.accessMode, fromKey, toKey),
    events: moveDraftKey(state.events, fromKey, toKey),
    catalogs: moveDraftKey(state.catalogs, fromKey, toKey),
    catalogNotices: moveDraftKey(state.catalogNotices, fromKey, toKey),
  };
}

/** 首发返回的会话属于新建目录，不再挂在草稿 id 上。 */
export function adoptCreatedChat<T extends DraftCarryState>(
  state: T,
  fromProjectId: string,
  session: Session,
): T {
  const to = session.project_id;
  if (!to || to === fromProjectId) return state;
  const sessions = { ...state.sessions };
  const list = sessions[fromProjectId];
  if (list) {
    delete sessions[fromProjectId];
    sessions[to] = list;
  }
  const activeSessionId = { ...state.activeSessionId };
  const active = activeSessionId[fromProjectId];
  delete activeSessionId[fromProjectId];
  if (active) activeSessionId[to] = active;
  const draftFocused = { ...state.draftFocused };
  delete draftFocused[fromProjectId];
  return {
    ...state,
    sessions,
    activeSessionId,
    draftFocused,
    selectedProjectId: to,
  };
}
