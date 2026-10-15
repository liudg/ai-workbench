/** Codex `followUpQueueMode`。`queue` 把回合中的后续输入排进队列，`steer` 写进当前回合。 */

export type FollowUpQueueMode = "queue" | "steer";

export const FOLLOW_UP_QUEUE_MODE_KEY = "ai-workbench.follow-up-queue-mode";

export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredFollowUpQueueMode {
  sessions: Record<string, FollowUpQueueMode>;
  agents: Record<string, FollowUpQueueMode>;
}

function asMode(value: unknown): FollowUpQueueMode | null {
  return value === "queue" || value === "steer" ? value : null;
}

function emptyStored(): StoredFollowUpQueueMode {
  return { sessions: {}, agents: {} };
}

function readStored(storage: ModeStorage | null): StoredFollowUpQueueMode {
  if (!storage) return emptyStored();
  let raw: string | null;
  try {
    raw = storage.getItem(FOLLOW_UP_QUEUE_MODE_KEY);
  } catch {
    return emptyStored();
  }
  if (!raw) return emptyStored();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyStored();
    const record = parsed as { sessions?: unknown; agents?: unknown };
    const sessions: Record<string, FollowUpQueueMode> = {};
    const agents: Record<string, FollowUpQueueMode> = {};
    if (record.sessions && typeof record.sessions === "object") {
      for (const [id, mode] of Object.entries(record.sessions)) {
        const parsedMode = asMode(mode);
        if (id && parsedMode) sessions[id] = parsedMode;
      }
    }
    if (record.agents && typeof record.agents === "object") {
      for (const [kind, mode] of Object.entries(record.agents)) {
        const parsedMode = asMode(mode);
        if (kind && parsedMode) agents[kind] = parsedMode;
      }
    }
    return { sessions, agents };
  } catch {
    return emptyStored();
  }
}

function writeStored(storage: ModeStorage | null, stored: StoredFollowUpQueueMode) {
  if (!storage) return;
  try {
    storage.setItem(FOLLOW_UP_QUEUE_MODE_KEY, JSON.stringify(stored));
  } catch {
    // 配额满时这次切换仍然作用在当前进程，只是重开后记不住。
  }
}

/** 本会话自己的选择优先，否则用这个 Agent 上一次的选择，默认排队。 */
export function readFollowUpQueueMode(
  storage: ModeStorage | null,
  sessionId: string,
  agent: string | null,
): FollowUpQueueMode {
  const stored = readStored(storage);
  return (
    (sessionId ? asMode(stored.sessions[sessionId]) : null) ??
    (agent ? asMode(stored.agents[agent]) : null) ??
    "queue"
  );
}

export function readSessionFollowUpQueueMode(
  storage: ModeStorage | null,
  sessionId: string,
): FollowUpQueueMode | null {
  if (!sessionId) return null;
  return asMode(readStored(storage).sessions[sessionId]);
}

/** 只记下这一会话，不改 Agent 的上次选择。 */
export function writeSessionFollowUpQueueMode(
  storage: ModeStorage | null,
  sessionId: string,
  mode: FollowUpQueueMode,
) {
  if (!sessionId) return;
  const stored = readStored(storage);
  stored.sessions[sessionId] = mode;
  writeStored(storage, stored);
}

/** 用户切换时：这一会话和这个 Agent 以后新建的会话都记住。 */
export function rememberFollowUpQueueMode(
  storage: ModeStorage | null,
  sessionId: string,
  agent: string | null,
  mode: FollowUpQueueMode,
) {
  const stored = readStored(storage);
  if (sessionId) stored.sessions[sessionId] = mode;
  if (agent) stored.agents[agent] = mode;
  writeStored(storage, stored);
}

export function toggleFollowUpQueueMode(mode: FollowUpQueueMode): FollowUpQueueMode {
  return mode === "queue" ? "steer" : "queue";
}

export function browserFollowUpQueueModeStorage(): ModeStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}
