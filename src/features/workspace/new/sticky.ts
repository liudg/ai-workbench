// 新会话默认用上次选的 Agent，以及这个 Agent 上次选的模型。记在本机。
// 照 t3code `apps/web/src/composerDraftStore.ts` 的 `stickyActiveProvider`、`stickyModelSelectionByProvider`。

import type { AgentKind, SessionTuning } from "@/types";

const STICKY_KEY = "ai-workbench.composer-sticky";

interface Sticky {
  agent: AgentKind | null;
  tuningByAgent: Partial<Record<AgentKind, SessionTuning>>;
}

function read(): Sticky {
  try {
    const raw = localStorage.getItem(STICKY_KEY);
    if (!raw) return { agent: null, tuningByAgent: {} };
    const parsed = JSON.parse(raw) as Partial<Sticky>;
    return {
      agent: typeof parsed.agent === "string" ? parsed.agent : null,
      tuningByAgent: parsed.tuningByAgent && typeof parsed.tuningByAgent === "object" ? parsed.tuningByAgent : {},
    };
  } catch {
    return { agent: null, tuningByAgent: {} };
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
