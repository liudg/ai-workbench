import type { AgentCatalog } from "../types/index.ts";
import { userFacingMessage } from "./user-facing.ts";

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

/**
 * 新建会话能不能用工作树。
 * 适配器 profile 是静态能力。会话目录可能是空的，或是加上这个字段之前的缓存，
 * 读出来是 false。这种 false 不能把 profile 关掉。
 * profile 还没到时，才看目录里已经写明的支持。
 */
export function sessionSupportsWorktree(
  catalog: { supports_worktree?: boolean } | null | undefined,
  profile: { supports_worktree?: boolean } | null | undefined,
): boolean {
  if (profile) return Boolean(profile.supports_worktree);
  return Boolean(catalog?.supports_worktree);
}

/** 作曲栏只读这一会话自己的目录。别的会话的 payload 不参与显示。 */
export function sessionCatalog(
  catalogs: Record<string, AgentCatalog>,
  sessionId: string,
): AgentCatalog | undefined {
  return catalogs[sessionId];
}

/** 同一会话里，空的新结果不能盖住这次会话已经拿到的模型。 */
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
    return { live: state.live, cached: state.cached, notice: userFacingMessage(outcome.message) };
  }

  const incoming = outcome.catalog;
  const notice = userFacingMessage(outcome.notice);
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
