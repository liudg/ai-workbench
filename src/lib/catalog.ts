import type { AgentCatalog, AgentKind, Session } from "../types/index.ts";

/** 与后端 `CATALOG_STALE_NOTICE` 同一句。有缓存时刷新失败只显示这一条。 */
export const CATALOG_STALE_NOTICE = "模型列表刷新失败，仍显示上次的模型。";

export interface CatalogMemory {
  live?: AgentCatalog;
  cached?: AgentCatalog;
  notice: string | null;
}

export type CatalogOutcome =
  | { ok: true; catalog: AgentCatalog; notice?: string | null }
  | { ok: false; message: string };

export function agentForSession(
  sessions: Record<string, Session[]>,
  sessionId: string,
): AgentKind | undefined {
  for (const list of Object.values(sessions)) {
    const found = list.find((session) => session.id === sessionId);
    if (found) return found.agent;
  }
  return undefined;
}

/** 本次刷新还没有结果时，先用该 Agent 上次成功的目录。空模型不能盖住已有模型。 */
export function preferCatalog(
  live: AgentCatalog | undefined,
  cached: AgentCatalog | undefined,
): AgentCatalog | undefined {
  if (live && live.models.length > 0) return live;
  if (cached && cached.models.length > 0) return cached;
  return live ?? cached;
}

export function reduceCatalogResult(state: CatalogMemory, outcome: CatalogOutcome): CatalogMemory {
  const kept = preferCatalog(state.live, state.cached);
  if (!outcome.ok) {
    if (kept && kept.models.length > 0) {
      return {
        live: kept,
        cached: state.cached?.models.length ? state.cached : kept,
        notice: CATALOG_STALE_NOTICE,
      };
    }
    return { live: state.live, cached: state.cached, notice: outcome.message };
  }

  const incoming = outcome.catalog;
  const trimmed = outcome.notice?.trim() ?? "";
  const notice = trimmed ? trimmed : null;
  if (incoming.models.length > 0) {
    const live = keepKnownSkills(incoming, kept);
    return { live, cached: live, notice };
  }
  if (kept && kept.models.length > 0) {
    return {
      live: kept,
      cached: state.cached?.models.length ? state.cached : kept,
      notice: notice ?? CATALOG_STALE_NOTICE,
    };
  }
  return { live: incoming, cached: state.cached, notice };
}

/** 这次没读到技能、但上次有，就留着上次的。失败不能把已有技能显示成空。 */
function keepKnownSkills(incoming: AgentCatalog, kept: AgentCatalog | undefined): AgentCatalog {
  if (incoming.skills.length > 0 || !incoming.skills_error || !kept?.skills.length) return incoming;
  return { ...incoming, skills: kept.skills, skills_error: null };
}

/** 有模型就显示模型名。只有确认没有目录时才显示「暂无模型」，加载中不显示。 */
export function modelButtonLabel(
  selectedLabel: string | undefined,
  catalog: AgentCatalog | undefined,
  notice: string | null,
): string {
  if (selectedLabel) return selectedLabel;
  if ((catalog && catalog.models.length === 0) || notice) return "暂无模型";
  return "读取模型…";
}
