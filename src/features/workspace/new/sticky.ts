// 新会话默认用上次选的 Agent / 实例，以及该实例上次选的模型与权限。记在本机。
// 照 t3code `apps/web/src/composerDraftStore.ts` 的 `stickyActiveProvider`、`stickyModelSelectionByProvider`。

import {
  defaultInstanceId,
  effectiveInstanceId,
  type AgentKind,
  type SessionSandbox,
  type SessionTuning,
} from "@/types";

const STICKY_KEY = "ai-workbench.composer-sticky";

export interface StickyAgentSelection {
  agent: AgentKind;
  instanceId: string;
}

interface Sticky {
  agent: AgentKind | null;
  instanceId: string | null;
  tuningByAgent: Partial<Record<string, SessionTuning>>;
  /** 同一个实例上次的权限，不拿去填另一个 Agent 或另一个实例。 */
  sandboxByAgent: Partial<Record<string, SessionSandbox>>;
  /** 各新建草稿页（如 `new:proj`）当前临时选中的实例。 */
  draftSelectionByKey: Partial<Record<string, StickyAgentSelection>>;
}

const EMPTY: Sticky = {
  agent: null,
  instanceId: null,
  tuningByAgent: {},
  sandboxByAgent: {},
  draftSelectionByKey: {},
};

const listeners = new Set<() => void>();
let revision = 0;

function emit() {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeSticky(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function stickyRevision(): number {
  return revision;
}

function read(): Sticky {
  try {
    const raw = localStorage.getItem(STICKY_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Sticky>;
    const record = <T,>(value: T | undefined): T | Record<string, never> =>
      value && typeof value === "object" ? value : {};
    const agent = typeof parsed.agent === "string" ? parsed.agent : null;
    const instanceId =
      typeof parsed.instanceId === "string" && parsed.instanceId.trim()
        ? parsed.instanceId.trim()
        : agent
          ? defaultInstanceId(agent)
          : null;
    return {
      agent,
      instanceId,
      tuningByAgent: record(parsed.tuningByAgent),
      sandboxByAgent: record(parsed.sandboxByAgent),
      draftSelectionByKey: record(parsed.draftSelectionByKey),
    };
  } catch {
    return EMPTY;
  }
}

function write(next: Sticky) {
  try {
    localStorage.setItem(STICKY_KEY, JSON.stringify(next));
  } catch {
    // 无痕模式或配额满时只是记不住，这次的选择照样生效。
  }
  emit();
}

export function stickySelection(): StickyAgentSelection | null {
  const current = read();
  if (!current.agent) return null;
  return {
    agent: current.agent,
    instanceId: effectiveInstanceId(current.agent, current.instanceId),
  };
}

export function rememberAgent(agent: AgentKind, instanceId?: string | null) {
  const current = read();
  write({
    ...current,
    agent,
    instanceId: effectiveInstanceId(agent, instanceId),
  });
}

export function draftSelectionForKey(key: string): StickyAgentSelection | null {
  const found = read().draftSelectionByKey[key];
  if (!found || typeof found.agent !== "string") return null;
  return {
    agent: found.agent,
    instanceId: effectiveInstanceId(found.agent, found.instanceId),
  };
}

export function rememberDraftSelection(key: string, selection: StickyAgentSelection | null) {
  const current = read();
  const nextMap = { ...current.draftSelectionByKey };
  if (selection) {
    nextMap[key] = {
      agent: selection.agent,
      instanceId: effectiveInstanceId(selection.agent, selection.instanceId),
    };
  } else {
    delete nextMap[key];
  }
  write({ ...current, draftSelectionByKey: nextMap });
}

export function stickyTuning(agent: AgentKind, instanceId?: string | null): SessionTuning | null {
  const key = effectiveInstanceId(agent, instanceId);
  return read().tuningByAgent[key] ?? null;
}

export function rememberTuning(
  agent: AgentKind,
  tuning: SessionTuning,
  instanceId?: string | null,
) {
  const current = read();
  const key = effectiveInstanceId(agent, instanceId);
  write({ ...current, tuningByAgent: { ...current.tuningByAgent, [key]: tuning } });
}

export function stickySandbox(
  agent: AgentKind,
  instanceId?: string | null,
): SessionSandbox | undefined {
  const key = effectiveInstanceId(agent, instanceId);
  return read().sandboxByAgent[key];
}

export function rememberSandbox(
  agent: AgentKind,
  sandbox: SessionSandbox,
  instanceId?: string | null,
) {
  const current = read();
  const key = effectiveInstanceId(agent, instanceId);
  write({ ...current, sandboxByAgent: { ...current.sandboxByAgent, [key]: sandbox } });
}
