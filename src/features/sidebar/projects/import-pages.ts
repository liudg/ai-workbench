import type { ImportCandidate } from "@/features/tasks";
import type { AgentKind } from "@/types";

/** 一个 Agent 已经读到的会话。`cursor` 为空且 `loaded` 时就是全部了。 */
export interface AgentPages {
  items: ImportCandidate[];
  cursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export type PagesByAgent = Partial<Record<AgentKind, AgentPages>>;

export const NO_PAGES: AgentPages = { items: [], cursor: null, loaded: false, loading: false, error: null };

export function importKey(item: Pick<ImportCandidate, "agent" | "nativeId">): string {
  return `${item.agent}:${item.nativeId}`;
}

/** 接上新的一页：去重，从新到旧。 */
export function mergeItems(current: ImportCandidate[], next: ImportCandidate[]): ImportCandidate[] {
  const byKey = new Map(current.map((item) => [importKey(item), item]));
  for (const item of next) byKey.set(importKey(item), item);
  return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function hasMore(pages: AgentPages): boolean {
  return !pages.loaded || pages.cursor !== null;
}

/** 标签上的数：没读完的后面带 `+`，第一页还没回来时不给。 */
export function countLabel(pages: AgentPages | undefined): string | null {
  if (!pages?.loaded) return null;
  return `${pages.items.length}${pages.cursor ? "+" : ""}`;
}

/** 没选过标签时打开最近用过的 Agent；都还没读到就是第一个。 */
export function defaultAgent(sources: AgentKind[], pages: PagesByAgent): AgentKind | null {
  let best: AgentKind | null = null;
  let latest = -Infinity;
  for (const agent of sources) {
    const first = pages[agent]?.items[0];
    if (first && first.updatedAt > latest) {
      best = agent;
      latest = first.updatedAt;
    }
  }
  return best ?? sources[0] ?? null;
}

/** 导入成功的从各自的列表里拿掉。 */
export function withoutKeys(pages: PagesByAgent, keys: ReadonlySet<string>): PagesByAgent {
  const next: PagesByAgent = {};
  for (const [agent, value] of Object.entries(pages) as [AgentKind, AgentPages][]) {
    next[agent] = { ...value, items: value.items.filter((item) => !keys.has(importKey(item))) };
  }
  return next;
}
