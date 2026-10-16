import { persistedAgentKind } from "../lib/agents.ts";
import { initialSandbox } from "../lib/sandbox.ts";
import type {
  AgentCatalog,
  AgentInstallation,
  AgentKind,
  Project,
  Session,
  SessionEvent,
  SessionSandbox,
  SessionTuning,
} from "../types/index.ts";
import { draftId, openProjectDraft } from "./draft-session.ts";
import type { PendingStart, SessionDraft } from "./types.ts";

export interface ProjectDraftFocusState {
  drafts: Record<string, SessionDraft>;
  draftFocused: Record<string, boolean>;
  activeSessionId: Record<string, string>;
  catalogs: Record<string, AgentCatalog>;
  catalogNotices: Record<string, string>;
  tuning: Record<string, SessionTuning>;
  sandboxes: Record<string, SessionSandbox>;
  events: Record<string, SessionEvent[]>;
}

/** 打开项目懒草稿。同一个 Agent 留下已输入的文字；换 Agent 时丢掉另一边的模型。 */
export function focusProjectDraft<T extends ProjectDraftFocusState>(
  state: T,
  projectId: string,
  agent: AgentKind,
  sandbox: SessionSandbox | null,
): Pick<
  T,
  | "drafts"
  | "draftFocused"
  | "activeSessionId"
  | "catalogs"
  | "catalogNotices"
  | "tuning"
  | "sandboxes"
  | "events"
> & { preferredAgent: AgentKind } {
  const existing = state.drafts[projectId];
  const next = openProjectDraft(existing, projectId, agent, sandbox);
  const id = draftId(projectId);
  const agentChanged = Boolean(existing && existing.agent !== next.agent);
  const activeSessionId = { ...state.activeSessionId };
  delete activeSessionId[projectId];
  const catalogs = { ...state.catalogs };
  const catalogNotices = { ...state.catalogNotices };
  const tuning = { ...state.tuning };
  const sandboxes = { ...state.sandboxes };
  const events = { ...state.events };
  if (!existing || agentChanged) {
    delete catalogs[id];
    delete catalogNotices[id];
    delete tuning[id];
    delete events[id];
    if (next.sandbox) sandboxes[id] = next.sandbox;
    else delete sandboxes[id];
  } else if (next.sandbox && !sandboxes[id]) {
    sandboxes[id] = next.sandbox;
  }
  return {
    preferredAgent: agent,
    drafts: { ...state.drafts, [projectId]: next },
    draftFocused: { ...state.draftFocused, [projectId]: true },
    activeSessionId,
    catalogs,
    catalogNotices,
    tuning,
    sandboxes,
    events,
  };
}

export interface LazyDraftState extends ProjectDraftFocusState {
  sessions: Record<string, readonly Session[] | undefined>;
  selectedProjectId: string | null;
  pendingStart: Record<string, PendingStart | undefined>;
  installations: AgentInstallation[] | null;
  preferredAgent: AgentKind | null;
  projects: readonly Pick<Project, "id" | "default_agent">[];
  profiles: Partial<Record<AgentKind, { default_access?: string | null }>>;
  lastSandboxByAgent: Partial<Record<AgentKind, SessionSandbox>>;
}

type FocusedDraft = ReturnType<typeof focusProjectDraft>;

export type EmptyProjectDraftPatch =
  | { mode: "focus"; value: FocusedDraft }
  | { mode: "reveal"; draftFocused: Record<string, boolean> };

/** 写回工作台时丢掉模式标记，只留状态字段。 */
export function emptyProjectDraftUpdate(
  patch: EmptyProjectDraftPatch,
): Partial<FocusedDraft> {
  if (patch.mode === "reveal") return { draftFocused: patch.draftFocused };
  return patch.value;
}

/**
 * 当前项目已经没有真实会话时，主区落到懒草稿。
 * 草稿已经在看，就什么都不改。安装列表还没到时，先用项目自己的默认 Agent。
 */
export function landOnEmptyProjectDraft(
  state: LazyDraftState,
  projectId: string,
): EmptyProjectDraftPatch | null {
  if (!projectId || state.selectedProjectId !== projectId) return null;
  const list = state.sessions[projectId];
  if (!list || list.length > 0) return null;

  const draft = state.drafts[projectId];
  const creating = draft?.phase === "creating" || Boolean(state.pendingStart[projectId]);
  if (creating) {
    if (!draft || state.draftFocused[projectId]) return null;
    return { mode: "reveal", draftFocused: { ...state.draftFocused, [projectId]: true } };
  }
  if (state.draftFocused[projectId] && draft) return null;

  const agent = agentForLazyDraft(state, projectId);
  if (!agent) return null;
  const sandbox = initialSandbox(
    state.lastSandboxByAgent[agent],
    state.profiles[agent]?.default_access,
  );
  return { mode: "focus", value: focusProjectDraft(state, projectId, agent, sandbox) };
}

function agentForLazyDraft(state: LazyDraftState, projectId: string): AgentKind | null {
  const current = state.drafts[projectId]?.agent;
  if (current) return current;
  const picked = persistedAgentKind(state.installations, state.preferredAgent);
  if (picked) return picked;
  if (state.installations == null) {
    return state.projects.find((project) => project.id === projectId)?.default_agent ?? null;
  }
  return null;
}
