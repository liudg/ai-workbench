import type { TextSnippet } from "@/shared/text-snippet";
import type {
  AccessMode,
  AgentCatalog,
  AgentKind,
  Attachment,
  PageAnnotation,
  Project,
  Session,
  SessionEvent,
  SessionSandbox,
  SessionTuning,
} from "@/types";
import { isStandaloneDraft } from "./standalone-id.ts";
import type { PendingStart, SessionDraft } from "./types";

export const DRAFT_PREFIX = "draft:";

export function draftId(projectId: string): string {
  return `${DRAFT_PREFIX}${projectId}`;
}

export function isDraftId(sessionId: string): boolean {
  return sessionId.startsWith(DRAFT_PREFIX);
}

/** 创建进行中的侧栏占位。不是真实会话 id，成功后换成后端返回的那条。 */
export const PENDING_PREFIX = "pending:";

export function pendingId(projectId: string): string {
  return `${PENDING_PREFIX}${projectId}`;
}

export function isPendingId(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_PREFIX);
}

export function pendingTitle(text: string): string {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line || "新对话";
}

/** 空草稿不进侧栏。只有创建进行中才有一行，native id 为空。 */
export function pendingSidebarSession(
  projectId: string,
  draft: SessionDraft | undefined,
  pending: PendingStart | undefined,
): Session | null {
  const creating = draft?.phase === "creating";
  if (!creating && !pending) return null;
  const agent = pending?.agent ?? draft?.agent;
  if (!agent) return null;
  const at = draft?.creatingSince || pending?.at || 0;
  const raw = creating ? pending?.title || draft?.text || "" : pending?.title || "";
  return {
    id: pendingId(projectId),
    project_id: projectId,
    agent,
    native_id: "",
    title: pendingTitle(raw),
    status: "running",
    created_at: at,
    updated_at: at,
    archived: false,
  };
}

export function projectOfDraft(sessionId: string): string | null {
  if (!isDraftId(sessionId)) return null;
  const projectId = sessionId.slice(DRAFT_PREFIX.length);
  return projectId ? projectId : null;
}

export function sessionFromDraft(draft: SessionDraft): Session {
  return {
    id: draftId(draft.projectId),
    project_id: draft.projectId,
    agent: draft.agent,
    native_id: "",
    title: "",
    status: "completed",
    created_at: 0,
    updated_at: 0,
    archived: false,
  };
}

export interface DraftMessage {
  text: string;
  images?: string[];
  annotations?: PageAnnotation[];
}

/** 首发一次交给后端的创建参数。Claude 和 Codex 走同一条。 */
export interface FirstSendBody {
  projectId: string;
  agent: AgentKind;
  accessMode: AccessMode | null;
  networkAccess: boolean;
  writableRoots: string[];
  profileId: string;
  applyAccess: boolean;
  model: string | null;
  effort: string | null;
  applyTuning: boolean;
  serviceTier: string | null;
  applyServiceTier: boolean;
  collaborationMode: "plan" | null;
  goal: string | null;
  goalStatus: "paused" | "active" | null;
  text: string;
  images: string[];
  annotations: PageAnnotation[];
  /** 首发时由工作台创建任务目录。普通项目会话为 false。 */
  standalone: boolean;
}

export function blankDraft(
  projectId: string,
  agent: AgentKind,
  sandbox: SessionSandbox | null,
): SessionDraft {
  return {
    projectId,
    agent,
    text: "",
    sandbox,
    tuning: null,
    collaboration: "default",
    goal: null,
    goalStatus: null,
    phase: "idle",
  };
}

/**
 * 每个项目一份草稿。
 * 同一个 Agent 再点新建，留下已输入的文字。
 * 换 Agent 时丢掉模型、计划和目标，避免把另一边的目录带过去。
 */
export function openProjectDraft(
  existing: SessionDraft | undefined,
  projectId: string,
  agent: AgentKind,
  sandbox: SessionSandbox | null,
): SessionDraft {
  if (!existing) return blankDraft(projectId, agent, sandbox);
  if (existing.phase === "creating") return existing;
  if (existing.agent === agent) return existing;
  return {
    ...existing,
    agent,
    sandbox,
    tuning: null,
    collaboration: "default",
    goal: null,
    goalStatus: null,
    phase: "idle",
  };
}

export function claimDraft(draft: SessionDraft | undefined): SessionDraft | null {
  if (!draft || draft.phase === "creating") return null;
  return { ...draft, phase: "creating" };
}

/** 失败或取消后只解开发送锁。文字、附件、沙箱和模型都留着。 */
export function releaseDraft(draft: SessionDraft): SessionDraft {
  if (draft.phase === "idle" && !draft.cancelRequested && draft.creatingSince === undefined) {
    return draft;
  }
  return { ...draft, phase: "idle", cancelRequested: false, creatingSince: undefined };
}

export function firstSendBody(draft: SessionDraft, message: DraftMessage): FirstSendBody {
  const sandbox = draft.sandbox;
  const applyAccess = Boolean(
    sandbox &&
      (sandbox.networkAccess ||
        sandbox.writableRoots.length > 0 ||
        sandbox.profileId ||
        sandbox.mode === "approve-for-me"),
  );
  const tuning = draft.tuning;
  const goal = draft.goal?.trim() || null;
  return {
    projectId: draft.projectId,
    agent: draft.agent,
    accessMode: sandbox ? (sandbox.profileId ? "ask" : sandbox.mode) : null,
    networkAccess: sandbox?.networkAccess ?? false,
    writableRoots: sandbox ? [...sandbox.writableRoots] : [],
    profileId: sandbox?.profileId ?? "",
    applyAccess,
    model: tuning?.model ?? null,
    effort: tuning?.effort ?? null,
    applyTuning: Boolean(tuning?.model),
    serviceTier: tuning && tuning.serviceTier !== undefined ? tuning.serviceTier : null,
    applyServiceTier: Boolean(tuning && tuning.serviceTier !== undefined),
    collaborationMode: draft.collaboration === "plan" ? "plan" : null,
    goal,
    goalStatus: goal ? draft.goalStatus : null,
    text: message.text,
    images: message.images ? [...message.images] : [],
    annotations: message.annotations ? [...message.annotations] : [],
    standalone: isStandaloneDraft(draft.projectId),
  };
}

export function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "发送失败，请重试";
}

const inflight = new Set<string>();

export function reserveDraftSend(projectId: string): boolean {
  if (inflight.has(projectId)) return false;
  inflight.add(projectId);
  return true;
}

export function releaseDraftSend(projectId: string): void {
  inflight.delete(projectId);
}

export async function runDraftSend<T>(
  projectId: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; skipped: boolean }> {
  if (!reserveDraftSend(projectId)) return { ok: false, error: "", skipped: true };
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: errorText(error), skipped: false };
  } finally {
    releaseDraftSend(projectId);
  }
}

export interface DraftCarryState {
  drafts: Record<string, SessionDraft>;
  draftFocused: Record<string, boolean>;
  activeSessionId: Record<string, string>;
  sessions: Record<string, Session[]>;
  attachments: Record<string, Attachment[]>;
  textSnippets: Record<string, TextSnippet[]>;
  sandboxes: Record<string, SessionSandbox>;
  tuning: Record<string, SessionTuning>;
  accessMode: Record<string, AccessMode>;
  events: Record<string, SessionEvent[]>;
  catalogs: Record<string, AgentCatalog>;
  catalogNotices: Record<string, string>;
  lastSandboxByAgent: Partial<Record<AgentKind, SessionSandbox>>;
  selectedProjectId: string | null;
  preferredAgent: AgentKind | null;
}

export function intentEvents(draft: SessionDraft): SessionEvent[] {
  const id = draftId(draft.projectId);
  const events: SessionEvent[] = [];
  if (draft.collaboration === "plan") {
    events.push({
      id: `${id}:plan`,
      session_id: id,
      seq: 1,
      ts: 0,
      kind: "collaboration-mode",
      mode: "plan",
    });
  }
  if (draft.goal?.trim()) {
    events.push({
      id: `${id}:goal`,
      session_id: id,
      seq: 2,
      ts: 0,
      kind: "goal",
      objective: draft.goal,
      status: draft.goalStatus ?? "active",
    });
  }
  return events;
}

function upsertEvent(
  events: SessionEvent[],
  sessionId: string,
  id: string,
  body: SessionEvent,
): SessionEvent[] {
  const index = events.findIndex((event) => event.id === id);
  if (index >= 0) {
    const next = events.slice();
    next[index] = body;
    return next;
  }
  const seq = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
  return [...events, { ...body, id, session_id: sessionId, seq }];
}

export function withCollaborationEvent(
  events: SessionEvent[],
  sessionId: string,
  mode: "plan" | "default",
): SessionEvent[] {
  const id = `${sessionId}:plan`;
  if (mode !== "plan") return events.filter((event) => event.id !== id);
  return upsertEvent(events, sessionId, id, {
    id,
    session_id: sessionId,
    seq: 1,
    ts: 0,
    kind: "collaboration-mode",
    mode: "plan",
  });
}

export function withGoalEvent(
  events: SessionEvent[],
  sessionId: string,
  objective: string,
  status: "paused" | "active",
): SessionEvent[] {
  const id = `${sessionId}:goal`;
  if (!objective.trim()) return events.filter((event) => event.id !== id);
  return upsertEvent(events, sessionId, id, {
    id,
    session_id: sessionId,
    seq: 2,
    ts: 0,
    kind: "goal",
    objective,
    status,
  });
}

export function mergeSession(list: readonly Session[] | undefined, session: Session): Session[] {
  const rest = (list ?? []).filter((item) => item.id !== session.id);
  return [session, ...rest].sort(
    (a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at,
  );
}

export type DraftSendResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; skipped: boolean };

/** 后端创建结果。messageError 有值表示会话在，但第一条消息没有发出。 */
export interface FirstSendOutcome {
  session: Session;
  messageError?: string | null;
  project?: Project | null;
}

export interface DraftSendSettle {
  sent: boolean;
  patch: (DraftCarryState & { lastError: string | null }) | null;
  /** 第一条没发出去时，把这段文字放进新会话的作曲栏。 */
  restore: { sessionId: string; text: string } | null;
}

const composerSeed = new Map<string, string>();

export function parkComposerText(sessionId: string, text: string): void {
  composerSeed.set(sessionId, text);
}

export function takeComposerText(sessionId: string): string | null {
  if (!composerSeed.has(sessionId)) return null;
  const text = composerSeed.get(sessionId) ?? "";
  composerSeed.delete(sessionId);
  return text;
}

function messageMissed(outcome: FirstSendOutcome): string | null {
  const text = outcome.messageError?.trim();
  return text ? text : null;
}

function unlockDraft(state: DraftCarryState, projectId: string): DraftCarryState["drafts"] {
  const current = state.drafts[projectId];
  if (!current) return state.drafts;
  return { ...state.drafts, [projectId]: releaseDraft(current) };
}

/**
 * 首发落定。
 * 创建本身失败：草稿留着，侧栏没有行。
 * 会话已建、第一条没发出：留下真实会话，草稿消失，作曲栏放回原文。
 * 用户在结果出来前停止，且消息没发出：解锁草稿，调用方再撤掉空会话。
 * 消息已经发出：停止来不及，按成功选中这条会话。
 */
export function applyDraftSend(
  state: DraftCarryState,
  projectId: string,
  result: DraftSendResult<FirstSendOutcome>,
  list: readonly Session[],
  options: { dismissed: boolean; sentText: string },
): DraftSendSettle {
  if (!result.ok) {
    if (result.skipped) return { sent: false, patch: null, restore: null };
    return {
      sent: false,
      restore: null,
      patch: {
        ...state,
        lastError: options.dismissed ? null : result.error,
        drafts: unlockDraft(state, projectId),
      },
    };
  }
  const missed = messageMissed(result.value);
  if (options.dismissed && missed) {
    return {
      sent: false,
      restore: null,
      patch: {
        ...state,
        lastError: null,
        drafts: unlockDraft(state, projectId),
      },
    };
  }
  if (missed) {
    return {
      sent: false,
      restore: { sessionId: result.value.session.id, text: options.sentText },
      patch: {
        ...finishDraft(state, projectId, result.value.session, list, true),
        lastError: missed,
      },
    };
  }
  return {
    sent: true,
    restore: null,
    patch: { ...finishDraft(state, projectId, result.value.session, list, false), lastError: null },
  };
}

/**
 * `/new` 带正文。不删掉项目里还没发出的草稿，只在创建期间锁住它。
 * 第一条没发出时，选中新建的会话并把这段正文放回作曲栏。
 */
export function applyThreadSend(
  state: DraftCarryState,
  projectId: string,
  result: DraftSendResult<FirstSendOutcome>,
  list: readonly Session[],
  options: { dismissed: boolean; sentText: string },
): DraftSendSettle {
  if (!result.ok) {
    if (result.skipped) return { sent: false, patch: null, restore: null };
    return {
      sent: false,
      restore: null,
      patch: {
        ...state,
        lastError: options.dismissed ? null : result.error,
        drafts: unlockDraft(state, projectId),
      },
    };
  }
  const missed = messageMissed(result.value);
  if (options.dismissed && missed) {
    return {
      sent: false,
      restore: null,
      patch: {
        ...state,
        lastError: null,
        drafts: unlockDraft(state, projectId),
      },
    };
  }
  const session = result.value.session;
  const released = unlockDraft(state, projectId);
  return {
    sent: !missed,
    restore: missed ? { sessionId: session.id, text: options.sentText } : null,
    patch: {
      ...state,
      drafts: released,
      draftFocused: { ...state.draftFocused, [projectId]: false },
      activeSessionId: { ...state.activeSessionId, [projectId]: session.id },
      sessions: { ...state.sessions, [projectId]: mergeSession(list, session) },
      lastError: missed,
      selectedProjectId: projectId,
      preferredAgent: session.agent,
    },
  };
}

/** 首发结束：草稿消失。消息没发出去时，附件留在新会话的作曲栏。 */
export function finishDraft(
  state: DraftCarryState,
  projectId: string,
  session: Session,
  list: readonly Session[],
  keepComposer = false,
): DraftCarryState {
  const id = draftId(projectId);
  const draft = state.drafts[projectId];
  const drafts = { ...state.drafts };
  delete drafts[projectId];
  const attachments = { ...state.attachments };
  const textSnippets = { ...state.textSnippets };
  if (keepComposer) {
    if (attachments[id]) attachments[session.id] = attachments[id];
    if (textSnippets[id]) textSnippets[session.id] = textSnippets[id];
  }
  delete attachments[id];
  delete textSnippets[id];
  const sandboxes = { ...state.sandboxes };
  const tuning = { ...state.tuning };
  const accessMode = { ...state.accessMode };
  delete sandboxes[id];
  delete tuning[id];
  delete accessMode[id];
  if (draft?.sandbox) {
    sandboxes[session.id] = draft.sandbox;
    accessMode[session.id] = draft.sandbox.profileId ? "ask" : draft.sandbox.mode;
  }
  if (draft?.tuning) tuning[session.id] = draft.tuning;
  const events = { ...state.events };
  delete events[id];
  const catalogs = { ...state.catalogs };
  const catalogNotices = { ...state.catalogNotices };
  const cached = catalogs[id];
  delete catalogs[id];
  delete catalogNotices[id];
  if (cached && (cached.agent == null || cached.agent === session.agent)) {
    catalogs[session.id] = cached;
  }
  return {
    ...state,
    drafts,
    draftFocused: { ...state.draftFocused, [projectId]: false },
    activeSessionId: { ...state.activeSessionId, [projectId]: session.id },
    sessions: { ...state.sessions, [projectId]: mergeSession(list, session) },
    attachments,
    textSnippets,
    sandboxes,
    tuning,
    accessMode,
    events,
    catalogs,
    catalogNotices,
    lastSandboxByAgent: draft?.sandbox
      ? { ...state.lastSandboxByAgent, [session.agent]: draft.sandbox }
      : state.lastSandboxByAgent,
    selectedProjectId: projectId,
    preferredAgent: session.agent,
  };
}

export function forgetProjectDraft(state: DraftCarryState, projectId: string): DraftCarryState {
  const id = draftId(projectId);
  const drafts = { ...state.drafts };
  const draftFocused = { ...state.draftFocused };
  delete drafts[projectId];
  delete draftFocused[projectId];
  const drop = <T,>(map: Record<string, T>) => {
    if (!(id in map)) return map;
    const next = { ...map };
    delete next[id];
    return next;
  };
  return {
    ...state,
    drafts,
    draftFocused,
    attachments: drop(state.attachments),
    textSnippets: drop(state.textSnippets),
    sandboxes: drop(state.sandboxes),
    tuning: drop(state.tuning),
    accessMode: drop(state.accessMode),
    events: drop(state.events),
    catalogs: drop(state.catalogs),
    catalogNotices: drop(state.catalogNotices),
  };
}
