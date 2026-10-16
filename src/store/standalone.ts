import type { Project, Session } from "@/types";
import { draftId, type DraftCarryState } from "./draft-session.ts";
import { STANDALONE_DRAFT_ID } from "./standalone-id.ts";
import type { SessionDraft } from "./types";

export { STANDALONE_DRAFT_ID, STANDALONE_DRAFT_TITLE, isStandaloneDraft } from "./standalone-id.ts";

export function visibleProjects(projects: readonly Project[]): Project[] {
  return projects.filter((project) => !project.standalone);
}

export function hasUserMessage(events: readonly { kind: string }[]): boolean {
  return events.some((event) => event.kind === "user-message");
}

/**
 * 空会话才显示项目选择：草稿，或已经载入且还没有用户消息的会话。
 * 第一条用户消息出现后隐藏。事件还没载入的真会话先不显示，避免旧会话闪一下。
 */
export function composerShowsWorkContext(input: {
  draft: boolean;
  eventsLoaded: boolean;
  hasUserMessage: boolean;
}): boolean {
  if (input.hasUserMessage) return false;
  return input.draft || input.eventsLoaded;
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

function hasUserProject(projects: readonly Pick<Project, "standalone">[]): boolean {
  return projects.some((project) => !project.standalone);
}

export function keepSelectedProjectId(input: {
  projects: readonly Pick<Project, "id" | "standalone">[];
  current: string | null;
  standaloneDraftFocused: boolean;
  /** 持久化下来的项目草稿。没有当前选择时回到这份草稿，而不是列表第一项。 */
  focusedProjectId?: string | null;
}): string | null {
  const userProject = hasUserProject(input.projects);
  // 没人打开过「新聊天」、侧栏也没有项目时，停在「选择一个项目」。
  if (input.current === STANDALONE_DRAFT_ID) {
    return input.standaloneDraftFocused || userProject ? STANDALONE_DRAFT_ID : null;
  }
  if (input.current && input.projects.some((project) => project.id === input.current)) {
    return input.current;
  }
  if (input.standaloneDraftFocused) return STANDALONE_DRAFT_ID;
  if (
    input.focusedProjectId &&
    input.projects.some((project) => project.id === input.focusedProjectId && !project.standalone)
  ) {
    return input.focusedProjectId;
  }
  return userProject ? STANDALONE_DRAFT_ID : null;
}

/**
 * 没有用户项目时，空白的「新聊天」不是一次选择。
 * 启动时丢掉它，主区回到「选择一个项目」。已经写过字的草稿留着。
 */
export function releaseUntouchedNewChat(input: {
  hasUserProject: boolean;
  selectedProjectId: string | null;
  draftText: string | undefined;
  draftFocused: Record<string, boolean>;
}): { selectedProjectId: string | null; draftFocused: Record<string, boolean> } | null {
  if (input.hasUserProject || input.draftText?.trim()) return null;
  const selected = input.selectedProjectId === STANDALONE_DRAFT_ID;
  const focused = Boolean(input.draftFocused[STANDALONE_DRAFT_ID]);
  if (!selected && !focused) return null;
  const draftFocused = { ...input.draftFocused };
  delete draftFocused[STANDALONE_DRAFT_ID];
  return {
    selectedProjectId: selected ? null : input.selectedProjectId,
    draftFocused,
  };
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

/** 空草稿还没交给适配器。选中另一个项目或独立聊天时，只改本地草稿归属。 */
export function retargetEmptyDraft(
  state: DraftCarryState,
  fromProjectId: string,
  targetProjectId: string,
): DraftCarryState | null {
  if (!fromProjectId || !targetProjectId || fromProjectId === targetProjectId) return null;
  const draft = state.drafts[fromProjectId];
  if (!draft || draft.phase === "creating") return null;
  if (state.drafts[targetProjectId]?.phase === "creating") return null;
  const fromKey = draftId(fromProjectId);
  const toKey = draftId(targetProjectId);
  const drafts = { ...state.drafts, [targetProjectId]: { ...draft, projectId: targetProjectId } };
  delete drafts[fromProjectId];
  const draftFocused = { ...state.draftFocused, [targetProjectId]: true };
  delete draftFocused[fromProjectId];
  const activeSessionId = { ...state.activeSessionId };
  delete activeSessionId[fromProjectId];
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

/** 独立草稿还没建目录。选中项目后，这段草稿改到那个项目里。 */
export function retargetStandaloneDraft(
  state: DraftCarryState,
  targetProjectId: string,
): DraftCarryState | null {
  return retargetEmptyDraft(state, STANDALONE_DRAFT_ID, targetProjectId);
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
