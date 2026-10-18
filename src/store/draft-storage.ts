import type { TextSnippet } from "@/shared/text-snippet";
import { AGENT_LABELS, type AgentKind, type Attachment, type SessionSandbox, type SessionTuning } from "@/types";
import { draftId, intentEvents } from "./draft-session";
import type { SessionDraft } from "./types";
import type { SessionEvent } from "@/types";

const STORAGE_KEY = "ai-workbench.session-drafts.v1";

export interface DraftSnapshot {
  drafts: Record<string, SessionDraft>;
  draftFocused: Record<string, boolean>;
  attachments: Record<string, Attachment[]>;
  textSnippets: Record<string, TextSnippet[]>;
  sandboxes: Record<string, SessionSandbox>;
  tuning: Record<string, SessionTuning>;
  events: Record<string, SessionEvent[]>;
}

interface PersistedDraft {
  projectId: string;
  agent: AgentKind;
  text: string;
  sandbox: SessionSandbox | null;
  tuning: SessionTuning | null;
  collaboration: "plan" | "default";
  goal: string | null;
  goalStatus: "paused" | "active" | null;
  attachments: Attachment[];
  textSnippets: TextSnippet[];
  focused: boolean;
  worktree?: boolean;
}

interface PersistedFile {
  drafts: PersistedDraft[];
}

const EMPTY: DraftSnapshot = {
  drafts: {},
  draftFocused: {},
  attachments: {},
  textSnippets: {},
  sandboxes: {},
  tuning: {},
  events: {},
};

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function isAgent(value: unknown): value is AgentKind {
  return typeof value === "string" && value in AGENT_LABELS;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asSandbox(value: unknown): SessionSandbox | null {
  if (!value || typeof value !== "object") return null;
  const sandbox = value as SessionSandbox;
  if (sandbox.mode !== "full" && sandbox.mode !== "ask" && sandbox.mode !== "read-only" && sandbox.mode !== "approve-for-me") {
    return null;
  }
  return {
    mode: sandbox.mode,
    networkAccess: Boolean(sandbox.networkAccess),
    writableRoots: Array.isArray(sandbox.writableRoots)
      ? sandbox.writableRoots.filter((item): item is string => typeof item === "string")
      : [],
    profileId: typeof sandbox.profileId === "string" ? sandbox.profileId : "",
  };
}

function asTuning(value: unknown): SessionTuning | null {
  if (!value || typeof value !== "object") return null;
  const tuning = value as SessionTuning;
  if (typeof tuning.model !== "string" || typeof tuning.effort !== "string") return null;
  return {
    model: tuning.model,
    effort: tuning.effort,
    ...(tuning.serviceTier !== undefined ? { serviceTier: tuning.serviceTier } : {}),
  };
}

function asAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const file = item as Attachment;
    if (typeof file.path !== "string" || typeof file.name !== "string") return [];
    return [{ path: file.path, name: file.name }];
  });
}

function asSnippets(value: unknown): TextSnippet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const snippet = item as TextSnippet;
    if (typeof snippet.id !== "string" || typeof snippet.path !== "string" || typeof snippet.quote !== "string") {
      return [];
    }
    return [snippet];
  });
}

function parseDraft(value: unknown): PersistedDraft | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PersistedDraft>;
  if (typeof raw.projectId !== "string" || !raw.projectId || !isAgent(raw.agent)) return null;
  const goalStatus = raw.goalStatus === "paused" || raw.goalStatus === "active" ? raw.goalStatus : null;
  return {
    projectId: raw.projectId,
    agent: raw.agent,
    text: asText(raw.text),
    sandbox: asSandbox(raw.sandbox),
    tuning: asTuning(raw.tuning),
    collaboration: raw.collaboration === "plan" ? "plan" : "default",
    goal: typeof raw.goal === "string" && raw.goal.trim() ? raw.goal : null,
    goalStatus,
    attachments: asAttachments(raw.attachments),
    textSnippets: asSnippets(raw.textSnippets),
    focused: Boolean(raw.focused),
    worktree: raw.worktree === true,
  };
}

export function readDraftSnapshot(): DraftSnapshot {
  const box = storage();
  if (!box) return EMPTY;
  let parsed: PersistedFile | null = null;
  try {
    const raw = box.getItem(STORAGE_KEY);
    parsed = raw ? (JSON.parse(raw) as PersistedFile) : null;
  } catch {
    return EMPTY;
  }
  if (!parsed || !Array.isArray(parsed.drafts)) return EMPTY;
  const snapshot: DraftSnapshot = {
    drafts: {},
    draftFocused: {},
    attachments: {},
    textSnippets: {},
    sandboxes: {},
    tuning: {},
    events: {},
  };
  for (const item of parsed.drafts) {
    const draft = parseDraft(item);
    if (!draft) continue;
    const session: SessionDraft = {
      projectId: draft.projectId,
      agent: draft.agent,
      text: draft.text,
      sandbox: draft.sandbox,
      tuning: draft.tuning,
      collaboration: draft.collaboration,
      goal: draft.goal,
      goalStatus: draft.goal ? draft.goalStatus : null,
      phase: "idle",
      ...(draft.worktree ? { worktree: true } : {}),
    };
    const id = draftId(draft.projectId);
    snapshot.drafts[draft.projectId] = session;
    if (draft.focused) snapshot.draftFocused[draft.projectId] = true;
    if (draft.attachments.length) snapshot.attachments[id] = draft.attachments;
    if (draft.textSnippets.length) snapshot.textSnippets[id] = draft.textSnippets;
    if (draft.sandbox) snapshot.sandboxes[id] = draft.sandbox;
    if (draft.tuning) snapshot.tuning[id] = draft.tuning;
    const events = intentEvents(session);
    if (events.length) snapshot.events[id] = events;
  }
  return snapshot;
}

export function writeDraftSnapshot(state: {
  drafts: Record<string, SessionDraft>;
  draftFocused: Record<string, boolean>;
  attachments: Record<string, Attachment[]>;
  textSnippets: Record<string, TextSnippet[]>;
  sandboxes: Record<string, SessionSandbox>;
  tuning: Record<string, SessionTuning>;
}): void {
  const box = storage();
  if (!box) return;
  const drafts: PersistedDraft[] = Object.values(state.drafts).map((draft) => {
    const id = draftId(draft.projectId);
    return {
      projectId: draft.projectId,
      agent: draft.agent,
      text: draft.text,
      sandbox: state.sandboxes[id] ?? draft.sandbox,
      tuning: state.tuning[id] ?? draft.tuning,
      collaboration: draft.collaboration,
      goal: draft.goal,
      goalStatus: draft.goalStatus,
      attachments: state.attachments[id] ?? [],
      textSnippets: state.textSnippets[id] ?? [],
      focused: Boolean(state.draftFocused[draft.projectId]),
      ...(draft.worktree ? { worktree: true } : {}),
    };
  });
  try {
    box.setItem(STORAGE_KEY, JSON.stringify({ drafts }));
  } catch {
    // 草稿写不进本地存储时，这次窗口里的内容仍然在。
  }
}
