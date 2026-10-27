// 新会话默认用上次选的 Agent，以及这个 Agent 上次选的模型。记在本机。
// 照 t3code `apps/web/src/composerDraftStore.ts` 的 `stickyActiveProvider`、`stickyModelSelectionByProvider`。

import type { AgentKind, SessionSandbox, SessionTuning } from "@/types";

const STICKY_KEY = "ai-workbench.composer-sticky";

interface Sticky {
  agent: AgentKind | null;
  tuningByAgent: Partial<Record<AgentKind, SessionTuning>>;
  /** 同一个 Agent 上次的权限，不拿去填另一个 Agent（沿用 v1 的 lastSandboxByAgent）。 */
  sandboxByAgent: Partial<Record<AgentKind, SessionSandbox>>;
}

const EMPTY: Sticky = { agent: null, tuningByAgent: {}, sandboxByAgent: {} };

function read(): Sticky {
  try {
    const raw = localStorage.getItem(STICKY_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Sticky>;
    const record = <T,>(value: T | undefined): T | Record<string, never> =>
      value && typeof value === "object" ? value : {};
    return {
      agent: typeof parsed.agent === "string" ? parsed.agent : null,
      tuningByAgent: record(parsed.tuningByAgent),
      sandboxByAgent: record(parsed.sandboxByAgent),
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
}

export function stickyAgent(): AgentKind | null {
  return read().agent;
}

export function stickyTuning(agent: AgentKind): SessionTuning | null {
  return read().tuningByAgent[agent] ?? null;
}

export function rememberAgent(agent: AgentKind) {
  write({ ...read(), agent });
}

export function rememberTuning(agent: AgentKind, tuning: SessionTuning) {
  const current = read();
  write({ ...current, tuningByAgent: { ...current.tuningByAgent, [agent]: tuning } });
}

export function stickySandbox(agent: AgentKind): SessionSandbox | undefined {
  return read().sandboxByAgent[agent];
}

export function rememberSandbox(agent: AgentKind, sandbox: SessionSandbox) {
  const current = read();
  write({ ...current, sandboxByAgent: { ...current.sandboxByAgent, [agent]: sandbox } });
}
