import { useEffect, useState } from "react";

import { agentsApi } from "@/features/agents";
import { userFacingMessage } from "@/lib/user-facing";
import type { AgentCatalog, AgentKind, PermissionMenu } from "@/types";
import { sessionCatalog, sessionPermissionMenu } from "./api";

/** 刷新失败但还有上次的目录时，作曲栏只显示这一条弱提示。 */
const STALE_NOTICE = "模型列表刷新失败，仍显示上次的模型。";
const MAX_SESSION_CATALOGS = 64;

const sessionCatalogs = new Map<string, AgentCatalog>();

function rememberSessionCatalog(sessionId: string, catalog: AgentCatalog) {
  sessionCatalogs.delete(sessionId);
  sessionCatalogs.set(sessionId, catalog);
  if (sessionCatalogs.size > MAX_SESSION_CATALOGS) {
    const oldest = sessionCatalogs.keys().next().value;
    if (oldest !== undefined) sessionCatalogs.delete(oldest);
  }
}

function matchingAgent(catalog: AgentCatalog | undefined, agent: AgentKind): AgentCatalog | undefined {
  if (!catalog || (catalog.agent && catalog.agent !== agent)) return undefined;
  return catalog;
}

function initialState(scope: string, sessionId: string, agent: AgentKind) {
  const own = matchingAgent(sessionCatalogs.get(sessionId), agent);
  return {
    scope,
    catalog: own ?? matchingAgent(agentsApi.peekCatalog(agent), agent),
    settled: own !== undefined,
    notice: null as string | null,
    permissionMenu: null as PermissionMenu | null,
  };
}

/**
 * 会话的模型目录和权限菜单。先用这种 Agent 上次的目录顶上，再向会话自己的 CLI 要；
 * 要不到时保留上次的目录，只给一条提示。
 */
export function useSessionCatalog(sessionId: string, agent: AgentKind) {
  const scope = `${sessionId}\0${agent}`;
  const [state, setState] = useState(() => initialState(scope, sessionId, agent));

  useEffect(() => {
    let cancelled = false;
    let fresh = false;
    let cachedShown = false;
    const base = initialState(scope, sessionId, agent);
    setState(base);
    const patch = (next: Partial<typeof base>) =>
      setState((prev) => (prev.scope === scope ? { ...prev, ...next } : { ...base, ...next }));

    if (!base.catalog) {
      void agentsApi.cachedCatalog(agent).then(
        (cached) => {
          const valid = matchingAgent(cached ?? undefined, agent);
          if (cancelled || fresh || !valid) return;
          cachedShown = true;
          patch({ catalog: valid });
        },
        () => {},
      );
    }
    void sessionCatalog(sessionId).then(
      (next) => {
        const valid = matchingAgent(next, agent);
        if (cancelled || !valid) return;
        fresh = true;
        if (valid.models.length > 0) {
          rememberSessionCatalog(sessionId, valid);
          agentsApi.rememberCatalog(agent, valid, false);
        }
        patch({ catalog: valid, settled: true });
      },
      (error: unknown) => {
        if (!cancelled) {
          patch({
            settled: true,
            notice: cachedShown || Boolean(base.catalog) ? STALE_NOTICE : userFacingMessage(error),
          });
        }
      },
    );
    void sessionPermissionMenu(sessionId).then(
      (menu) => {
        if (!cancelled) patch({ permissionMenu: menu });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [agent, scope, sessionId]);

  const active = state.scope === scope ? state : initialState(scope, sessionId, agent);
  return {
    catalog: active.catalog,
    catalogSettled: active.settled,
    notice: active.notice,
    permissionMenu: active.permissionMenu,
  };
}
