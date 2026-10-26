import { useEffect, useState } from "react";

import { agentsApi } from "@/features/agents";
import { userFacingMessage } from "@/lib/user-facing";
import type { AgentCatalog, AgentKind, PermissionMenu } from "@/types";
import { sessionCatalog, sessionPermissionMenu } from "./api";

/** 刷新失败但还有上次的目录时，作曲栏只显示这一条弱提示。 */
const STALE_NOTICE = "模型列表刷新失败，仍显示上次的模型。";

/**
 * 会话的模型目录和权限菜单。先用这种 Agent 上次的目录顶上，再向会话自己的 CLI 要；
 * 要不到时保留上次的目录，只给一条提示。
 */
export function useSessionCatalog(sessionId: string, agent: AgentKind) {
  const [catalog, setCatalog] = useState<AgentCatalog | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [permissionMenu, setPermissionMenu] = useState<PermissionMenu | null>(null);

  useEffect(() => {
    let cancelled = false;
    let fresh = false;
    let cachedShown = false;
    setCatalog(undefined);
    setNotice(null);
    setPermissionMenu(null);
    void agentsApi.cachedCatalog(agent).then(
      (cached) => {
        if (cancelled || fresh || !cached) return;
        cachedShown = true;
        setCatalog(cached);
      },
      () => {},
    );
    void sessionCatalog(sessionId).then(
      (next) => {
        if (cancelled) return;
        fresh = true;
        setCatalog(next);
      },
      (error: unknown) => {
        if (!cancelled) setNotice(cachedShown ? STALE_NOTICE : userFacingMessage(error));
      },
    );
    void sessionPermissionMenu(sessionId).then(
      (menu) => {
        if (!cancelled) setPermissionMenu(menu);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [agent, sessionId]);

  return { catalog, notice, permissionMenu };
}
