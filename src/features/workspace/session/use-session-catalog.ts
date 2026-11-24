import { useEffect, useState } from "react";

import { agentsApi } from "@/features/agents";
import { matchingInstanceCatalog } from "@/lib/agents";
import { userFacingMessage } from "@/lib/user-facing";
import { effectiveInstanceId, type AgentCatalog, type AgentKind, type PermissionMenu } from "@/types";
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

function initialState(
  scope: string,
  sessionId: string,
  agent: AgentKind,
  instanceId?: string | null,
) {
  const own = matchingInstanceCatalog(sessionCatalogs.get(sessionId), agent, instanceId);
  return {
    scope,
    catalog: own ?? agentsApi.peekCatalog(agent, instanceId),
    settled: own !== undefined,
    notice: null as string | null,
    permissionMenu: null as PermissionMenu | null,
  };
}

/**
 * 会话的模型目录和权限菜单。先用该实例上次的目录顶上，再向会话自己的 CLI 要；
 * 要不到时保留上次的目录，只给一条提示。
 */
export function useSessionCatalog(
  sessionId: string,
  agent: AgentKind,
  instanceId?: string | null,
) {
  const instanceKey = effectiveInstanceId(agent, instanceId);
  const scope = `${sessionId}\0${instanceKey}`;
  const [state, setState] = useState(() => initialState(scope, sessionId, agent, instanceId));

  useEffect(() => {
    let cancelled = false;
    let fresh = false;
    let cachedShown = false;
    const base = initialState(scope, sessionId, agent, instanceId);
    setState(base);
    const patch = (next: Partial<typeof base>) =>
      setState((prev) => (prev.scope === scope ? { ...prev, ...next } : { ...base, ...next }));

    if (!base.catalog) {
      void agentsApi.cachedCatalog(agent, instanceId).then(
        (cached) => {
          const valid = matchingInstanceCatalog(cached, agent, instanceId);
          if (cancelled || fresh || !valid) return;
          cachedShown = true;
          patch({ catalog: valid });
        },
        () => {},
      );
    }
    void sessionCatalog(sessionId).then(
      (next) => {
        if (cancelled) return;
        const valid = matchingInstanceCatalog(next, agent, instanceId);
        if (!valid) {
          patch({ settled: true });
          return;
        }
        fresh = true;
        if (valid.models.length > 0) {
          rememberSessionCatalog(sessionId, valid);
          agentsApi.rememberCatalog(agent, valid, false, instanceId);
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
  }, [agent, instanceId, instanceKey, scope, sessionId]);

  const active =
    state.scope === scope ? state : initialState(scope, sessionId, agent, instanceId);
  return {
    catalog: active.catalog,
    catalogSettled: active.settled,
    notice: active.notice,
    permissionMenu: active.permissionMenu,
  };
}
